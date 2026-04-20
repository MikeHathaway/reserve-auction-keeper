// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IAjnaPoolLike, IERC20Like, ISwapRouterLike} from "./FlashArbExecutor.sol";

interface IUniswapV2Callee {
    function uniswapV2Call(address sender, uint256 amount0, uint256 amount1, bytes calldata data) external;
}

interface IUniswapV2FactoryLike {
    function getPair(address tokenA, address tokenB) external view returns (address);
}

interface IUniswapV2PairLike {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

/// @title FlashArbExecutorV2V3
/// @notice Executor for Ajna reserve-auction flash-arb with a Uniswap V2 flash source
/// and a Uniswap V3 swap back to AJNA. Operator-only; holds no persistent funds.
/// @dev Authentication in the V2 callback: (1) msg.sender is a canonical factory pair,
/// (2) msg.sender equals `activeFlashPair`, (3) `sender == address(this)` (V2 passes
/// the swap() caller), (4) keccak256(data) equals `activeCallbackHash`.
contract FlashArbExecutorV2V3 is IUniswapV2Callee {
    error Unauthorized();
    error UnauthorizedCallback();
    error ActiveFlashExecution();
    error InvalidAddress();
    error InvalidConfig();
    error InvalidParams();
    error InvalidFlashPair();
    error InvalidFactoryPair();
    error InvalidBorrowBalance();
    error InvalidQuoteAmount();
    error InvalidSwapPath();
    error UnsupportedBorrowToken();
    error InsufficientRepayment();

    // Uniswap V2 swap-fee constants. The protocol takes a 0.30% fee on every swap,
    // so a flash-loan of `x` AJNA must be repaid with `ceil(x * 1000 / 997)`.
    uint256 private constant UNISWAP_V2_FEE_DENOMINATOR = 1000;
    uint256 private constant UNISWAP_V2_FEE_NUMERATOR = 997; // denominator - 3 (for 0.30% fee)

    struct ExecuteParams {
        address flashPair;
        address ajnaPool;
        uint256 borrowAmount;
        uint256 quoteAmount;
        bytes swapPath;
        uint256 minAjnaOut;
        address profitRecipient;
    }

    address public immutable ajnaToken;
    address public immutable swapRouter;
    address public immutable uniswapV2Factory;
    address public immutable owner;

    address private activeFlashPair;
    bytes32 private activeCallbackHash;
    uint256 private preFlashAjnaBalance;
    // Load-bearing for TWO invariants: (1) `nonReentrant` modifier guard,
    // (2) `_isFlashActive()` gate that blocks `recoverToken` during execution.
    // Any refactor that changes this variable's lifecycle must preserve both.
    bool private flashExecutionActive;

    event FlashArbExecuted(
        address indexed flashPair,
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
        address uniswapV2Factory_
    ) {
        if (ajnaToken_ == address(0) || swapRouter_ == address(0) || uniswapV2Factory_ == address(0)) {
            revert InvalidAddress();
        }

        ajnaToken = ajnaToken_;
        swapRouter = swapRouter_;
        uniswapV2Factory = uniswapV2Factory_;
        owner = msg.sender;
    }

    /// @notice Initiate a V2-flash → Ajna takeReserves → V3-swap → repay+profit cycle.
    /// @dev Must be called by the operator. Pins the caller-intended `flashPair` and
    /// the full param hash to storage; V2 pair invokes `uniswapV2Call` on us.
    /// @param params Flash source, Ajna pool, sizing, swap path, and profit recipient.
    function executeFlashArb(ExecuteParams calldata params) external onlyOwner nonReentrant {
        _validateParams(params);
        (bool ok, address token0, address token1) = _readPairIdentity(params.flashPair);
        if (!ok) revert InvalidFlashPair();

        uint256 amount0Out;
        uint256 amount1Out;
        if (token0 == ajnaToken) {
            amount0Out = params.borrowAmount;
        } else if (token1 == ajnaToken) {
            amount1Out = params.borrowAmount;
        } else {
            revert UnsupportedBorrowToken();
        }

        activeFlashPair = params.flashPair;
        activeCallbackHash = keccak256(abi.encode(params));
        preFlashAjnaBalance = IERC20Like(ajnaToken).balanceOf(address(this));
        IUniswapV2PairLike(params.flashPair).swap(amount0Out, amount1Out, address(this), abi.encode(params));
        activeFlashPair = address(0);
        activeCallbackHash = bytes32(0);
        preFlashAjnaBalance = 0;
    }

    /// @notice Uniswap V2 flash callback. Authenticates: `sender == address(this)`
    /// (V2 guarantees this is the caller of `swap`), `msg.sender == activeFlashPair`,
    /// and `keccak256(data) == activeCallbackHash`. Together these preclude both
    /// opportunistic callers and counterfeit pair contracts.
    function uniswapV2Call(
        address sender,
        uint256 /* amount0 */,
        uint256 /* amount1 */,
        bytes calldata data
    ) external override {
        if (sender != address(this)) revert UnauthorizedCallback();
        if (msg.sender != activeFlashPair || keccak256(data) != activeCallbackHash) {
            revert UnauthorizedCallback();
        }
        ExecuteParams memory params = abi.decode(data, (ExecuteParams));
        activeFlashPair = address(0);
        activeCallbackHash = bytes32(0);

        // Verify the flash pair actually delivered at least `borrowAmount` AJNA —
        // compare current balance to the pinned pre-flash balance. This does NOT
        // trust the callback-reported amounts (which are the pair's self-reported
        // amountOut values and can be inflated by a malicious or buggy pair).
        uint256 preExistingAjnaBalance = preFlashAjnaBalance;
        uint256 startingAjnaBalance = IERC20Like(ajnaToken).balanceOf(address(this));
        if (startingAjnaBalance - preExistingAjnaBalance < params.borrowAmount) {
            revert InvalidBorrowBalance();
        }
        uint256 repayAmount = _calculateRepayAmount(params.borrowAmount);

        _approveExact(ajnaToken, params.ajnaPool, params.borrowAmount);

        address quoteToken;
        uint256 quoteTokenAmount;
        {
            (bool ok, address token0, address token1) = _readPairIdentity(params.flashPair);
            if (!ok) revert InvalidFlashPair();
            if (!_isCanonicalFactoryPair(params.flashPair, token0, token1)) {
                revert InvalidFactoryPair();
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
        uint256 amountOut = ISwapRouterLike(swapRouter).exactInput(
            ISwapRouterLike.ExactInputParams({
                path: params.swapPath,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: quoteTokenAmount,
                amountOutMinimum: params.minAjnaOut
            })
        );
        if (amountOut < repayAmount) revert InsufficientRepayment();

        _transferToken(ajnaToken, params.flashPair, repayAmount);

        uint256 profit = IERC20Like(ajnaToken).balanceOf(address(this)) - preExistingAjnaBalance;
        if (profit > 0) {
            _transferToken(ajnaToken, params.profitRecipient, profit);
        }

        emit FlashArbExecuted(
            params.flashPair,
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

    function isCanonicalFactoryPair(address flashPair) external view returns (bool) {
        return _isCanonicalFactoryPair(flashPair);
    }

    function _isCanonicalFactoryPair(address flashPair) internal view returns (bool) {
        (bool ok, address token0, address token1) = _readPairIdentity(flashPair);
        if (!ok) return false;
        return _isCanonicalFactoryPair(flashPair, token0, token1);
    }

    function _isCanonicalFactoryPair(
        address flashPair,
        address token0,
        address token1
    ) internal view returns (bool) {
        return IUniswapV2FactoryLike(uniswapV2Factory).getPair(token0, token1) == flashPair;
    }

    function _validateSwapPath(
        bytes memory path,
        address expectedInputToken,
        address expectedOutputToken
    ) internal pure {
        if (path.length < 43 || (path.length - 20) % 23 != 0) revert InvalidSwapPath();

        uint256 offset = 0;
        address tokenIn = _readPathAddress(path, offset);
        if (tokenIn != expectedInputToken) revert InvalidSwapPath();

        while (offset + 20 < path.length) {
            tokenIn = _readPathAddress(path, offset + 23);
            offset += 23;
        }

        if (tokenIn != expectedOutputToken) revert InvalidSwapPath();
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
            params.flashPair == address(0) ||
            params.ajnaPool == address(0) ||
            params.profitRecipient == address(0)
        ) revert InvalidAddress();

        if (
            params.borrowAmount == 0 ||
            params.quoteAmount == 0 ||
            params.swapPath.length == 0
        ) revert InvalidParams();
    }

    /// @dev ceil(borrowAmount * 1000 / 997) — the exact amount of AJNA we must
    /// return to the pair to keep the V2 constant-product invariant intact after
    /// the 0.30% swap fee is applied to our flash borrow.
    function _calculateRepayAmount(uint256 borrowAmount) internal pure returns (uint256) {
        return (borrowAmount * UNISWAP_V2_FEE_DENOMINATOR + UNISWAP_V2_FEE_NUMERATOR - 1)
            / UNISWAP_V2_FEE_NUMERATOR;
    }

    function _isFlashActive() internal view returns (bool) {
        return flashExecutionActive;
    }

    function _readPathAddress(bytes memory path, uint256 start) internal pure returns (address addr) {
        if (path.length < start + 20) revert InvalidSwapPath();
        assembly {
            addr := shr(96, mload(add(add(path, 0x20), start)))
        }
    }

    function _readPairIdentity(
        address flashPair
    ) internal view returns (bool ok, address token0, address token1) {
        if (flashPair.code.length == 0) {
            return (false, address(0), address(0));
        }

        IUniswapV2PairLike pair = IUniswapV2PairLike(flashPair);
        try pair.token0() returns (address token0_) {
            token0 = token0_;
        } catch {
            return (false, address(0), address(0));
        }

        try pair.token1() returns (address token1_) {
            token1 = token1_;
        } catch {
            return (false, address(0), address(0));
        }

        return (true, token0, token1);
    }
}
