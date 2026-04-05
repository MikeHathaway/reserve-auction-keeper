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
    function quoteTokenScale() external view returns (uint256);
}

interface IUniswapV3FlashCallback {
    function uniswapV3FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external;
}

interface IUniswapV3PoolLike {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
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
    error UnauthorizedCallback();
    error InvalidAddress();
    error InvalidConfig();
    error InvalidFlashPool();
    error InvalidFactoryPool();
    error InvalidBorrowBalance();
    error InvalidQuoteAmount();
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
    address public immutable uniswapV3Factory;
    bytes32 public immutable uniswapV3PoolInitCodeHash;
    address public immutable owner;

    address private activeFlashPool;
    bytes32 private activeCallbackHash;

    event FlashArbExecuted(
        address indexed flashPool,
        address indexed ajnaPool,
        uint256 quoteTokenAmount,
        uint256 borrowedAjna,
        uint256 repaidAjna,
        uint256 profitAjna
    );

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

        activeFlashPool = params.flashPool;
        activeCallbackHash = keccak256(abi.encode(params));
        flashPool.flash(address(this), amount0, amount1, abi.encode(params));
        activeFlashPool = address(0);
        activeCallbackHash = bytes32(0);
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
        if (!_isCanonicalFactoryPool(params.flashPool)) revert InvalidFactoryPool();

        uint256 startingAjnaBalance = IERC20Like(ajnaToken).balanceOf(address(this));
        if (startingAjnaBalance < params.borrowAmount) revert InvalidBorrowBalance();
        uint256 preExistingAjnaBalance = startingAjnaBalance - params.borrowAmount;
        uint256 repayAmount = params.borrowAmount + fee0 + fee1;

        _approveExact(ajnaToken, params.ajnaPool, params.borrowAmount);

        IAjnaPoolLike ajnaPool = IAjnaPoolLike(params.ajnaPool);
        uint256 quoteReceived = ajnaPool.takeReserves(params.quoteAmount);

        address quoteToken = ajnaPool.quoteTokenAddress();
        uint256 quoteTokenScale = ajnaPool.quoteTokenScale();
        if (quoteTokenScale == 0 || quoteReceived % quoteTokenScale != 0) {
            revert InvalidQuoteAmount();
        }

        uint256 quoteTokenAmount = quoteReceived / quoteTokenScale;
        if (quoteTokenAmount == 0) revert InvalidQuoteAmount();

        _approveExact(quoteToken, swapRouter, quoteTokenAmount);

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

    function _approveExact(address token, address spender, uint256 amount) internal {
        if (!IERC20Like(token).approve(spender, 0)) revert InvalidAddress();
        if (!IERC20Like(token).approve(spender, amount)) revert InvalidAddress();
    }

    function _transferToken(address token, address to, uint256 amount) internal {
        if (!IERC20Like(token).transfer(to, amount)) revert InvalidAddress();
    }

    function isCanonicalFactoryPool(address flashPool) external view returns (bool) {
        return _isCanonicalFactoryPool(flashPool);
    }

    function _isCanonicalFactoryPool(address flashPool) internal view returns (bool) {
        IUniswapV3PoolLike pool = IUniswapV3PoolLike(flashPool);
        bytes32 salt = keccak256(abi.encode(pool.token0(), pool.token1(), pool.fee()));
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
}
