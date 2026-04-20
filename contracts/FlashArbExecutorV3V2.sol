// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IAjnaPoolLike, IERC20Like, IUniswapV3FlashCallback, IUniswapV3PoolLike} from "./FlashArbExecutor.sol";

interface IUniswapV2RouterLike {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

/// @title FlashArbExecutorV3V2
/// @notice Executor for Ajna reserve-auction flash-arb with a Uniswap V3 flash source
/// and a Uniswap V2 swap back to AJNA. Operator-only; holds no persistent funds.
/// @dev Security relies on three layered checks in the flash callback:
/// (1) msg.sender is a canonical Uniswap V3 pool (CREATE2 address matches factory),
/// (2) msg.sender equals the `activeFlashPool` set by `executeFlashArb`,
/// (3) keccak256(callback data) equals the `activeCallbackHash` of the originally
/// submitted params. Any bypass attempt must break all three.
contract FlashArbExecutorV3V2 is IUniswapV3FlashCallback {
    error Unauthorized();
    error UnauthorizedCallback();
    error ActiveFlashExecution();
    error InvalidAddress();
    error InvalidConfig();
    error InvalidParams();
    error InvalidFlashPool();
    error InvalidFactoryPool();
    error InvalidBorrowBalance();
    error InvalidQuoteAmount();
    error InvalidSwapPath();
    error UnsupportedBorrowToken();
    error InsufficientRepayment();

    struct ExecuteParams {
        address flashPool;
        address ajnaPool;
        uint256 borrowAmount;
        uint256 quoteAmount;
        address[] swapPath;
        uint256 minAjnaOut;
        address profitRecipient;
    }

    address public immutable ajnaToken;
    address public immutable swapRouter;
    address public immutable uniswapV3Factory;
    bytes32 public immutable uniswapV3PoolInitCodeHash;
    address public immutable owner;

    address private activeFlashPool;
    bytes32 private activeCallbackHash;
    uint256 private preFlashAjnaBalance;
    // Load-bearing for TWO invariants: (1) `nonReentrant` modifier guard,
    // (2) `_isFlashActive()` gate that blocks `recoverToken` during execution.
    // Any refactor that changes this variable's lifecycle must preserve both.
    bool private flashExecutionActive;

    event FlashArbExecuted(
        address indexed flashPool,
        address indexed ajnaPool,
        uint256 quoteTokenAmount,
        uint256 borrowedAjna,
        uint256 repaidAjna,
        uint256 profitAjna
    );
    event TokenRecovered(address indexed token, address indexed to, uint256 amount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    /// @dev Reuses `flashExecutionActive` as a reentrancy guard. Prevents the owner
    /// (or any contract the owner routes through) from invoking `executeFlashArb`
    /// recursively while a flash is in progress.
    modifier nonReentrant() {
        if (flashExecutionActive) revert ActiveFlashExecution();
        flashExecutionActive = true;
        _;
        flashExecutionActive = false;
    }

    constructor(
        address ajnaToken_,
        address swapRouter_,
        address uniswapV3Factory_,
        bytes32 uniswapV3PoolInitCodeHash_
    ) {
        if (ajnaToken_ == address(0) || swapRouter_ == address(0) || uniswapV3Factory_ == address(0)) {
            revert InvalidAddress();
        }
        if (uniswapV3PoolInitCodeHash_ == bytes32(0)) revert InvalidConfig();

        ajnaToken = ajnaToken_;
        swapRouter = swapRouter_;
        uniswapV3Factory = uniswapV3Factory_;
        uniswapV3PoolInitCodeHash = uniswapV3PoolInitCodeHash_;
        owner = msg.sender;
    }

    /// @notice Initiate a V3-flash → Ajna takeReserves → V2-swap → repay+profit cycle.
    /// @dev Must be called by the operator. Pins the caller-intended `flashPool` and
    /// the full param hash to storage, then invokes `flash()`; the pool calls back
    /// into `uniswapV3FlashCallback` where the same storage is used to authenticate.
    /// @param params Flash source, Ajna pool, sizing, V2 swap path, and profit recipient.
    function executeFlashArb(ExecuteParams calldata params) external onlyOwner nonReentrant {
        _validateParams(params);
        (bool ok, address token0, address token1, ) = _readPoolIdentity(params.flashPool);
        if (!ok) revert InvalidFlashPool();
        IUniswapV3PoolLike flashPool = IUniswapV3PoolLike(params.flashPool);

        uint256 amount0;
        uint256 amount1;
        if (token0 == ajnaToken) {
            amount0 = params.borrowAmount;
        } else if (token1 == ajnaToken) {
            amount1 = params.borrowAmount;
        } else {
            revert UnsupportedBorrowToken();
        }

        activeFlashPool = params.flashPool;
        activeCallbackHash = keccak256(abi.encode(params));
        preFlashAjnaBalance = IERC20Like(ajnaToken).balanceOf(address(this));
        flashPool.flash(address(this), amount0, amount1, abi.encode(params));
        activeFlashPool = address(0);
        activeCallbackHash = bytes32(0);
        preFlashAjnaBalance = 0;
    }

    /// @notice Uniswap V3 flash callback. Authenticates the caller against the
    /// `activeFlashPool` + `activeCallbackHash` pinned by `executeFlashArb`, then
    /// performs the Ajna take, V2 swap, repay, and profit disbursement.
    /// @dev The `keccak256(data) == activeCallbackHash` check implicitly requires
    /// `params.flashPool == activeFlashPool == msg.sender`, since the hash was
    /// computed over the exact params the operator submitted.
    function uniswapV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external override {
        if (msg.sender != activeFlashPool || keccak256(data) != activeCallbackHash) {
            revert UnauthorizedCallback();
        }
        ExecuteParams memory params = abi.decode(data, (ExecuteParams));
        activeFlashPool = address(0);
        activeCallbackHash = bytes32(0);

        // Verify the flash pool actually delivered at least `borrowAmount` AJNA —
        // compare current balance to the pinned pre-flash balance. The subtraction
        // reverts on underflow, which would mean the pool transferred tokens OUT of
        // us during flash (impossible for a well-behaved pool).
        uint256 preExistingAjnaBalance = preFlashAjnaBalance;
        uint256 startingAjnaBalance = IERC20Like(ajnaToken).balanceOf(address(this));
        if (startingAjnaBalance - preExistingAjnaBalance < params.borrowAmount) {
            revert InvalidBorrowBalance();
        }
        uint256 repayAmount = params.borrowAmount + fee0 + fee1;

        _approveExact(ajnaToken, params.ajnaPool, params.borrowAmount);

        address quoteToken;
        uint256 quoteTokenAmount;
        {
            (bool ok, address flashToken0, address flashToken1, uint24 flashFee) =
                _readPoolIdentity(params.flashPool);
            if (!ok) revert InvalidFlashPool();
            if (!_isCanonicalFactoryPool(params.flashPool, flashToken0, flashToken1, flashFee)) {
                revert InvalidFactoryPool();
            }

            IAjnaPoolLike ajnaPool = IAjnaPoolLike(params.ajnaPool);
            uint256 quoteReceived = ajnaPool.takeReserves(params.quoteAmount);

            quoteToken = ajnaPool.quoteTokenAddress();
            uint256 quoteTokenScale = ajnaPool.quoteTokenScale();
            if (quoteTokenScale == 0 || quoteReceived % quoteTokenScale != 0) {
                revert InvalidQuoteAmount();
            }

            quoteTokenAmount = quoteReceived / quoteTokenScale;
            if (quoteTokenAmount == 0) revert InvalidQuoteAmount();
            _validateSwapPath(params.swapPath, quoteToken, ajnaToken);
        }

        _approveExact(quoteToken, swapRouter, quoteTokenAmount);

        // deadline: block.timestamp — the entire flash-arb is atomic within this
        // transaction, so there is no staleness window for a deadline to guard against.
        uint256[] memory amounts = IUniswapV2RouterLike(swapRouter).swapExactTokensForTokens(
            quoteTokenAmount,
            params.minAjnaOut,
            params.swapPath,
            address(this),
            block.timestamp
        );
        uint256 amountOut = amounts[amounts.length - 1];
        if (amountOut < repayAmount) revert InsufficientRepayment();

        _transferToken(ajnaToken, params.flashPool, repayAmount);

        uint256 profit = IERC20Like(ajnaToken).balanceOf(address(this)) - preExistingAjnaBalance;
        if (profit > 0) {
            _transferToken(ajnaToken, params.profitRecipient, profit);
        }

        emit FlashArbExecuted(
            params.flashPool,
            params.ajnaPool,
            quoteTokenAmount,
            params.borrowAmount,
            repayAmount,
            profit
        );
    }

    /// @notice Sweep any token held by this contract to a recipient. Intended for
    /// recovering dust, blacklisted tokens, or funds stuck after a partial-fill
    /// edge case. Blocked during an active flash execution.
    function recoverToken(address token, address to, uint256 amount) external onlyOwner {
        if (_isFlashActive()) revert ActiveFlashExecution();
        if (token == address(0) || to == address(0)) revert InvalidAddress();

        _transferToken(token, to, amount);
        emit TokenRecovered(token, to, amount);
    }

    function isCanonicalFactoryPool(address flashPool) external view returns (bool) {
        return _isCanonicalFactoryPool(flashPool);
    }

    function _isCanonicalFactoryPool(address flashPool) internal view returns (bool) {
        (bool ok, address token0, address token1, uint24 fee) = _readPoolIdentity(flashPool);
        if (!ok) return false;
        return _isCanonicalFactoryPool(flashPool, token0, token1, fee);
    }

    function _isCanonicalFactoryPool(
        address flashPool,
        address token0,
        address token1,
        uint24 fee
    ) internal view returns (bool) {
        bytes32 salt = keccak256(abi.encode(token0, token1, fee));
        address expected = address(uint160(uint256(
            keccak256(
                abi.encodePacked(
                    hex"ff",
                    uniswapV3Factory,
                    salt,
                    uniswapV3PoolInitCodeHash
                )
            )
        )));

        return expected == flashPool;
    }

    function _approveExact(address token, address spender, uint256 amount) internal {
        _safeTokenCall(token, abi.encodeWithSelector(IERC20Like.approve.selector, spender, uint256(0)));
        _safeTokenCall(token, abi.encodeWithSelector(IERC20Like.approve.selector, spender, amount));
    }

    function _transferToken(address token, address to, uint256 amount) internal {
        _safeTokenCall(token, abi.encodeWithSelector(IERC20Like.transfer.selector, to, amount));
    }

    // Safe ERC20 call: accepts both standard (returns bool) and non-standard
    // (returns nothing, e.g. USDT) tokens. Revert reasons from the token are
    // preserved via assembly-level bubble-up; otherwise reverts InvalidAddress.
    function _safeTokenCall(address token, bytes memory data) private {
        (bool success, bytes memory returnData) = token.call(data);
        if (!success) {
            if (returnData.length > 0) {
                assembly {
                    revert(add(returnData, 32), mload(returnData))
                }
            }
            revert InvalidAddress();
        }
        if (returnData.length > 0 && !abi.decode(returnData, (bool))) revert InvalidAddress();
    }

    function _validateParams(ExecuteParams calldata params) internal pure {
        if (
            params.flashPool == address(0) ||
            params.ajnaPool == address(0) ||
            params.profitRecipient == address(0)
        ) revert InvalidAddress();

        if (
            params.borrowAmount == 0 ||
            params.quoteAmount == 0 ||
            params.swapPath.length < 2
        ) revert InvalidParams();
    }

    /// @dev No flash-pool-reuse guard is needed here. The flash source is a Uniswap
    /// V3 pool, while the swap path routes through Uniswap V2 pairs — different
    /// protocols with different contract addresses, so reuse is impossible by
    /// construction. If this contract is ever generalized to allow V3 hops in the
    /// swap path, reintroduce the flash-pool-reuse check from FlashArbExecutor.sol
    /// to prevent nested V3 callback reentrancy.
    function _validateSwapPath(
        address[] memory path,
        address expectedInputToken,
        address expectedOutputToken
    ) internal pure {
        if (path.length < 2) revert InvalidSwapPath();
        if (path[0] != expectedInputToken) revert InvalidSwapPath();
        if (path[path.length - 1] != expectedOutputToken) revert InvalidSwapPath();
    }

    function _isFlashActive() internal view returns (bool) {
        return flashExecutionActive;
    }

    function _readPoolIdentity(
        address flashPool
    ) internal view returns (bool ok, address token0, address token1, uint24 fee) {
        if (flashPool.code.length == 0) {
            return (false, address(0), address(0), 0);
        }

        IUniswapV3PoolLike pool = IUniswapV3PoolLike(flashPool);
        try pool.token0() returns (address token0_) {
            token0 = token0_;
        } catch {
            return (false, address(0), address(0), 0);
        }

        try pool.token1() returns (address token1_) {
            token1 = token1_;
        } catch {
            return (false, address(0), address(0), 0);
        }

        try pool.fee() returns (uint24 fee_) {
            fee = fee_;
        } catch {
            return (false, address(0), address(0), 0);
        }

        return (true, token0, token1, fee);
    }
}
