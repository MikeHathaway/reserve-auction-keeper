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

    function executeFlashArb(ExecuteParams calldata params) external onlyOwner {
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
        flashExecutionActive = true;
        flashPool.flash(address(this), amount0, amount1, abi.encode(params));
        activeFlashPool = address(0);
        activeCallbackHash = bytes32(0);
        flashExecutionActive = false;
    }

    function uniswapV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external override {
        ExecuteParams memory params = abi.decode(data, (ExecuteParams));
        if (msg.sender != params.flashPool) revert InvalidFlashPool();
        if (msg.sender != activeFlashPool || keccak256(data) != activeCallbackHash) {
            revert UnauthorizedCallback();
        }
        activeFlashPool = address(0);
        activeCallbackHash = bytes32(0);

        uint256 startingAjnaBalance = IERC20Like(ajnaToken).balanceOf(address(this));
        if (startingAjnaBalance < params.borrowAmount) revert InvalidBorrowBalance();
        uint256 preExistingAjnaBalance = startingAjnaBalance - params.borrowAmount;
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
        if (!IERC20Like(token).approve(spender, 0)) revert InvalidAddress();
        if (!IERC20Like(token).approve(spender, amount)) revert InvalidAddress();
    }

    function _transferToken(address token, address to, uint256 amount) internal {
        if (!IERC20Like(token).transfer(to, amount)) revert InvalidAddress();
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
