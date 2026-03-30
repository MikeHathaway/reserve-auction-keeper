// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IERC20Like {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IAjnaPoolLike {
    function takeReserves(uint256 amount) external returns (uint256);
    function quoteTokenAddress() external view returns (address);
}

interface IUniswapV3FlashCallback {
    function uniswapV3FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external;
}

interface IUniswapV3PoolLike {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function flash(address recipient, uint256 amount0, uint256 amount1, bytes calldata data) external;
}

interface ISwapRouterLike {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

contract FlashArbExecutor is IUniswapV3FlashCallback {
    error Unauthorized();
    error InvalidAddress();
    error InvalidFlashPool();
    error UnsupportedBorrowToken();
    error InsufficientRepayment();

    struct ExecuteParams {
        address flashPool;
        address ajnaPool;
        uint256 borrowAmount;
        uint256 quoteAmount;
        bytes swapPath;
        uint256 minAjnaOut;
        address profitRecipient;
    }

    address public immutable ajnaToken;
    address public immutable swapRouter;
    address public immutable owner;

    event FlashArbExecuted(
        address indexed flashPool,
        address indexed ajnaPool,
        uint256 quoteAmount,
        uint256 borrowedAjna,
        uint256 repaidAjna,
        uint256 profitAjna
    );

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address ajnaToken_, address swapRouter_) {
        if (ajnaToken_ == address(0) || swapRouter_ == address(0)) {
            revert InvalidAddress();
        }

        ajnaToken = ajnaToken_;
        swapRouter = swapRouter_;
        owner = msg.sender;
    }

    function executeFlashArb(ExecuteParams calldata params) external onlyOwner {
        IUniswapV3PoolLike flashPool = IUniswapV3PoolLike(params.flashPool);

        address token0 = flashPool.token0();
        address token1 = flashPool.token1();

        uint256 amount0;
        uint256 amount1;
        if (token0 == ajnaToken) {
            amount0 = params.borrowAmount;
        } else if (token1 == ajnaToken) {
            amount1 = params.borrowAmount;
        } else {
            revert UnsupportedBorrowToken();
        }

        flashPool.flash(address(this), amount0, amount1, abi.encode(params));
    }

    function uniswapV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external override {
        ExecuteParams memory params = abi.decode(data, (ExecuteParams));
        if (msg.sender != params.flashPool) revert InvalidFlashPool();

        uint256 repayAmount = params.borrowAmount + fee0 + fee1;

        _approveExact(ajnaToken, params.ajnaPool, params.borrowAmount);

        IAjnaPoolLike ajnaPool = IAjnaPoolLike(params.ajnaPool);
        uint256 quoteReceived = ajnaPool.takeReserves(params.quoteAmount);

        address quoteToken = ajnaPool.quoteTokenAddress();
        _approveExact(quoteToken, swapRouter, quoteReceived);

        uint256 amountOut = ISwapRouterLike(swapRouter).exactInput(
            ISwapRouterLike.ExactInputParams({
                path: params.swapPath,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: quoteReceived,
                amountOutMinimum: params.minAjnaOut
            })
        );

        if (amountOut < repayAmount) revert InsufficientRepayment();

        _transferToken(ajnaToken, params.flashPool, repayAmount);

        uint256 profit = IERC20Like(ajnaToken).balanceOf(address(this));
        if (profit > 0) {
            _transferToken(ajnaToken, params.profitRecipient, profit);
        }

        emit FlashArbExecuted(
            params.flashPool,
            params.ajnaPool,
            quoteReceived,
            params.borrowAmount,
            repayAmount,
            profit
        );
    }

    function _approveExact(address token, address spender, uint256 amount) internal {
        if (!IERC20Like(token).approve(spender, 0)) revert InvalidAddress();
        if (!IERC20Like(token).approve(spender, amount)) revert InvalidAddress();
    }

    function _transferToken(address token, address to, uint256 amount) internal {
        if (!IERC20Like(token).transfer(to, amount)) revert InvalidAddress();
    }
}
