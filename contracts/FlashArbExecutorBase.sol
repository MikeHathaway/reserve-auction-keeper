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

/// @title FlashArbExecutorBase
/// @notice Shared state, helpers, and invariants for the Ajna reserve-auction
/// flash-arb executor family (V3V3, V2V3, V3V2). Each concrete executor inherits
/// from this and adds only its DEX-specific flash initiation, callback entry
/// point, and swap-path validation.
/// @dev Invariants provided by this base:
/// (a) `onlyOwner` gating on privileged functions,
/// (b) `nonReentrant` reentrancy guard on concrete `executeFlashArb` overrides,
/// (c) `recoverToken` blocked while a flash is active,
/// (d) `_safeTokenCall` that accepts both standard (returns bool) and
///     non-standard (returns nothing, e.g. USDT) ERC20s,
/// (e) pre-flash AJNA balance snapshot available to concrete callbacks via
///     `preFlashAjnaBalance` so under-delivery can be detected.
abstract contract FlashArbExecutorBase {
    error Unauthorized();
    error UnauthorizedCallback();
    error ActiveFlashExecution();
    error InvalidAddress();
    error InvalidParams();
    error InvalidBorrowBalance();
    error InvalidQuoteAmount();
    error InvalidSwapPath();
    error UnsupportedBorrowToken();
    error InsufficientRepayment();

    address public immutable ajnaToken;
    address public immutable swapRouter;
    address public immutable owner;

    // Common flash-execution state. `activeCallbackHash` pins the callback data
    // to the exact params the operator submitted. `preFlashAjnaBalance` lets
    // concrete callbacks detect flash-source under-delivery by comparing the
    // post-flash balance delta to `params.borrowAmount`.
    //
    // Load-bearing for TWO invariants: (1) `nonReentrant` modifier guard,
    // (2) the `recoverToken` guard via `_isFlashActive()`.
    // Any refactor that changes `flashExecutionActive`'s lifecycle must preserve
    // both. Concrete executors add `activeFlashPool` or `activeFlashPair` in
    // their own storage slots.
    bytes32 internal activeCallbackHash;
    uint256 internal preFlashAjnaBalance;
    bool internal flashExecutionActive;

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

    constructor(address ajnaToken_, address swapRouter_) {
        if (ajnaToken_ == address(0) || swapRouter_ == address(0)) {
            revert InvalidAddress();
        }
        ajnaToken = ajnaToken_;
        swapRouter = swapRouter_;
        owner = msg.sender;
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

    function _isFlashActive() internal view returns (bool) {
        return flashExecutionActive;
    }

    function _approveExact(address token, address spender, uint256 amount) internal {
        _safeTokenCall(token, abi.encodeWithSelector(IERC20Like.approve.selector, spender, uint256(0)));
        _safeTokenCall(token, abi.encodeWithSelector(IERC20Like.approve.selector, spender, amount));
    }

    function _transferToken(address token, address to, uint256 amount) internal {
        _safeTokenCall(token, abi.encodeWithSelector(IERC20Like.transfer.selector, to, amount));
    }

    // Safe ERC20 call: accepts both standard (returns bool) and non-standard
    // (returns nothing, e.g. USDT) tokens. Token revert reasons are preserved
    // via assembly-level bubble-up. Three failure cases:
    //   (1) call reverted with a reason → bubble up that reason,
    //   (2) call reverted without a reason → revert InvalidAddress,
    //   (3) call succeeded but returned `false` → revert InvalidAddress.
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
}
