// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {
    FlashArbExecutorBase,
    IAjnaPoolLike,
    IERC20Like,
    ISwapRouterLike,
    IUniswapV3FlashCallback,
    IUniswapV3PoolLike,
    PATH_ADDRESS_BYTES,
    PATH_FEE_BYTES,
    PATH_HOP_BYTES,
    PATH_MIN_BYTES,
    PATH_ADDRESS_SHIFT,
    PATH_FEE_SHIFT
} from "./FlashArbExecutorBase.sol";

/// @title FlashArbExecutor (V3V3)
/// @notice Executor for Ajna reserve-auction flash-arb with a Uniswap V3 flash source
/// and a Uniswap V3 swap back to AJNA. Operator-only; holds no persistent funds.
/// @dev Security relies on three layered checks in the flash callback:
/// (1) msg.sender is a canonical Uniswap V3 pool (CREATE2 address matches factory),
/// (2) msg.sender equals the `activeFlashPool` set by `executeFlashArb`,
/// (3) keccak256(callback data) equals the `activeCallbackHash` of the originally
/// submitted params. Any bypass attempt must break all three.
contract FlashArbExecutor is FlashArbExecutorBase, IUniswapV3FlashCallback {
    error InvalidConfig();
    error InvalidFlashPool();
    error InvalidFactoryPool();
    error FlashPoolReuseInSwapPath();

    struct ExecuteParams {
        address flashPool;
        address ajnaPool;
        uint256 borrowAmount;
        uint256 quoteAmount;
        bytes swapPath;
        uint256 minAjnaOut;
        address profitRecipient;
    }

    address public immutable uniswapV3Factory;
    bytes32 public immutable uniswapV3PoolInitCodeHash;

    address private activeFlashPool;

    event FlashArbExecuted(
        address indexed flashPool,
        address indexed ajnaPool,
        uint256 quoteTokenAmount,
        uint256 borrowedAjna,
        uint256 repaidAjna,
        uint256 profitAjna
    );

    constructor(
        address ajnaToken_,
        address swapRouter_,
        address uniswapV3Factory_,
        bytes32 uniswapV3PoolInitCodeHash_
    ) FlashArbExecutorBase(ajnaToken_, swapRouter_) {
        if (uniswapV3Factory_ == address(0)) revert InvalidAddress();
        if (uniswapV3PoolInitCodeHash_ == bytes32(0)) revert InvalidConfig();

        uniswapV3Factory = uniswapV3Factory_;
        uniswapV3PoolInitCodeHash = uniswapV3PoolInitCodeHash_;
    }

    /// @notice Initiate a V3-flash → Ajna takeReserves → V3-swap → repay+profit cycle.
    /// @dev Must be called by the operator. Pins the caller-intended `flashPool` and
    /// the full param hash to storage, then invokes `flash()`; the pool calls back
    /// into `uniswapV3FlashCallback` where the same storage is used to authenticate.
    /// @param params Flash source, Ajna pool, sizing, swap path, and profit recipient.
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
    /// performs the Ajna take, swap, repay, and profit disbursement.
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
        // compare current balance to the pinned pre-flash balance. Explicit
        // underflow guard ensures `InvalidBorrowBalance` surfaces instead of a
        // generic Panic(0x11) if the pool (impossibly, for a well-behaved pool)
        // transferred tokens OUT of us during flash.
        uint256 preExistingAjnaBalance = preFlashAjnaBalance;
        uint256 startingAjnaBalance = IERC20Like(ajnaToken).balanceOf(address(this));
        if (
            startingAjnaBalance < preExistingAjnaBalance ||
            startingAjnaBalance - preExistingAjnaBalance < params.borrowAmount
        ) {
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

            // Residual allowance from under-consumption (takeReserves pulled
            // less than params.borrowAmount at current auction price) would let
            // a malicious or later-compromised ajnaPool drain future AJNA from
            // this contract. Revoke immediately.
            _revokeApproval(ajnaToken, params.ajnaPool);

            quoteToken = ajnaPool.quoteTokenAddress();
            uint256 quoteTokenScale = ajnaPool.quoteTokenScale();
            if (quoteTokenScale == 0 || quoteReceived % quoteTokenScale != 0) {
                revert InvalidQuoteAmount();
            }

            quoteTokenAmount = quoteReceived / quoteTokenScale;
            if (quoteTokenAmount == 0) revert InvalidQuoteAmount();
            _validateSwapPath(
                params.swapPath,
                quoteToken,
                ajnaToken,
                flashToken0,
                flashToken1,
                flashFee
            );
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

        // Revoke any residual quote-token allowance to the router in the same
        // spirit as the ajnaPool revoke above — routers generally consume the
        // full approved amount, but defense-in-depth prevents future drain
        // vectors if the router is ever upgraded or compromised.
        _revokeApproval(quoteToken, swapRouter);

        if (amountOut < repayAmount) revert InsufficientRepayment();

        _transferToken(ajnaToken, params.flashPool, repayAmount);

        uint256 profit = IERC20Like(ajnaToken).balanceOf(address(this)) -
            preExistingAjnaBalance;
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

    function _validateSwapPath(
        bytes memory path,
        address expectedInputToken,
        address expectedOutputToken,
        address flashToken0,
        address flashToken1,
        uint24 flashFee
    ) internal pure {
        if (
            path.length < PATH_MIN_BYTES ||
            (path.length - PATH_ADDRESS_BYTES) % PATH_HOP_BYTES != 0
        ) revert InvalidSwapPath();

        uint256 offset = 0;
        address tokenIn = _readPathAddress(path, offset);
        if (tokenIn != expectedInputToken) revert InvalidSwapPath();

        while (offset + PATH_ADDRESS_BYTES < path.length) {
            uint24 fee = _readPathFee(path, offset + PATH_ADDRESS_BYTES);
            address tokenOut = _readPathAddress(path, offset + PATH_HOP_BYTES);
            if (_pathHopMatchesPool(tokenIn, tokenOut, fee, flashToken0, flashToken1, flashFee)) {
                revert FlashPoolReuseInSwapPath();
            }

            tokenIn = tokenOut;
            offset += PATH_HOP_BYTES;
        }

        if (tokenIn != expectedOutputToken) revert InvalidSwapPath();
    }

    function _pathHopMatchesPool(
        address tokenA,
        address tokenB,
        uint24 fee,
        address flashToken0,
        address flashToken1,
        uint24 flashFee
    ) internal pure returns (bool) {
        if (fee != flashFee) return false;
        (address normalizedFlashToken0, address normalizedFlashToken1) =
            flashToken0 < flashToken1
                ? (flashToken0, flashToken1)
                : (flashToken1, flashToken0);
        (address token0, address token1) =
            tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return token0 == normalizedFlashToken0 && token1 == normalizedFlashToken1;
    }

    function _readPathAddress(bytes memory path, uint256 start) internal pure returns (address addr) {
        if (path.length < start + PATH_ADDRESS_BYTES) revert InvalidSwapPath();
        assembly {
            addr := shr(PATH_ADDRESS_SHIFT, mload(add(add(path, 0x20), start)))
        }
    }

    function _readPathFee(bytes memory path, uint256 start) internal pure returns (uint24 fee) {
        if (path.length < start + PATH_FEE_BYTES) revert InvalidSwapPath();
        assembly {
            fee := shr(PATH_FEE_SHIFT, mload(add(add(path, 0x20), start)))
        }
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
            params.swapPath.length == 0
        ) revert InvalidParams();
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
