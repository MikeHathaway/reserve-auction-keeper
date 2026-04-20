// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FlashArbExecutor} from "../FlashArbExecutor.sol";
import {FlashArbExecutorBase, IERC20Like, ISwapRouterLike} from "../FlashArbExecutorBase.sol";
import {Log, TestBase} from "./TestBase.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockNonStandardERC20} from "./mocks/MockNonStandardERC20.sol";
import {MockFalseReturningERC20} from "./mocks/MockFalseReturningERC20.sol";
import {MockAjnaPool} from "./mocks/MockAjnaPool.sol";
import {MockMalformedAjnaPool} from "./mocks/MockMalformedAjnaPool.sol";
import {MockSwapRouter} from "./mocks/MockSwapRouter.sol";
import {MockUniswapV3Factory} from "./mocks/MockUniswapV3Factory.sol";
import {MockUniswapV3Pool} from "./mocks/MockUniswapV3Pool.sol";
import {
    MockUnderdeliveringUniswapV3Factory,
    MockUnderdeliveringUniswapV3Pool
} from "./mocks/MockUnderdeliveringUniswapV3Pool.sol";

contract OwnerProxy {
    function deployExecutor(
        address ajnaToken,
        address swapRouter,
        address uniswapV3Factory,
        bytes32 initCodeHash
    ) external returns (FlashArbExecutor) {
        return new FlashArbExecutor(ajnaToken, swapRouter, uniswapV3Factory, initCodeHash);
    }

    function executeFlashArb(
        FlashArbExecutor executor,
        FlashArbExecutor.ExecuteParams memory params
    ) external {
        executor.executeFlashArb(params);
    }

    function attemptRecoverToken(
        FlashArbExecutor executor,
        address token,
        address to,
        uint256 amount
    ) external returns (bool) {
        try executor.recoverToken(token, to, amount) {
            return true;
        } catch {
            return false;
        }
    }

    function attemptExecuteFlashArb(
        FlashArbExecutor executor,
        FlashArbExecutor.ExecuteParams memory params
    ) external returns (bool) {
        try executor.executeFlashArb(params) {
            return true;
        } catch {
            return false;
        }
    }
}

// Router that attempts to re-enter `executeFlashArb` during `exactInput`. Used
// to verify the `nonReentrant` modifier rejects recursive entry while a flash
// is in progress.
contract ReenteringExecuteRouter is ISwapRouterLike {
    address public immutable quoteToken;
    address public immutable ajnaToken;
    OwnerProxy public immutable ownerProxy;
    FlashArbExecutor public executor;

    uint256 public nextAmountOut;
    FlashArbExecutor.ExecuteParams public recursiveParams;
    bool public recursiveAttempted;
    bool public recursiveSucceeded;

    constructor(
        address quoteToken_,
        address ajnaToken_,
        OwnerProxy ownerProxy_
    ) {
        quoteToken = quoteToken_;
        ajnaToken = ajnaToken_;
        ownerProxy = ownerProxy_;
    }

    function setExecutor(FlashArbExecutor executor_) external {
        executor = executor_;
    }

    function setNextAmountOut(uint256 amountOut) external {
        nextAmountOut = amountOut;
    }

    function setRecursiveParams(FlashArbExecutor.ExecuteParams memory params) external {
        recursiveParams = params;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut) {
        require(
            IERC20Like(quoteToken).transferFrom(msg.sender, address(this), params.amountIn),
            "QUOTE_IN"
        );

        recursiveAttempted = true;
        recursiveSucceeded = ownerProxy.attemptExecuteFlashArb(executor, recursiveParams);

        require(nextAmountOut >= params.amountOutMinimum, "MIN_OUT");
        require(
            IERC20Like(ajnaToken).transfer(params.recipient, nextAmountOut),
            "AJNA_OUT"
        );

        return nextAmountOut;
    }
}

contract ReenteringRecoverRouter is ISwapRouterLike {
    address public immutable quoteToken;
    address public immutable ajnaToken;
    OwnerProxy public immutable ownerProxy;
    FlashArbExecutor public executor;

    address public recoveryToken;
    address public recoveryRecipient;
    uint256 public recoveryAmount;
    uint256 public nextAmountOut;
    bool public recoveryAttempted;
    bool public recoverySucceeded;

    constructor(
        address quoteToken_,
        address ajnaToken_,
        OwnerProxy ownerProxy_
    ) {
        quoteToken = quoteToken_;
        ajnaToken = ajnaToken_;
        ownerProxy = ownerProxy_;
    }

    function setExecutor(FlashArbExecutor executor_) external {
        executor = executor_;
    }

    function setNextAmountOut(uint256 amountOut) external {
        nextAmountOut = amountOut;
    }

    function setRecovery(address token, address recipient, uint256 amount) external {
        recoveryToken = token;
        recoveryRecipient = recipient;
        recoveryAmount = amount;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut) {
        require(
            IERC20Like(quoteToken).transferFrom(msg.sender, address(this), params.amountIn),
            "QUOTE_IN"
        );

        recoveryAttempted = true;
        recoverySucceeded = ownerProxy.attemptRecoverToken(
            executor,
            recoveryToken,
            recoveryRecipient,
            recoveryAmount
        );

        require(nextAmountOut >= params.amountOutMinimum, "MIN_OUT");
        require(
            IERC20Like(ajnaToken).transfer(params.recipient, nextAmountOut),
            "AJNA_OUT"
        );

        return nextAmountOut;
    }
}

contract FlashArbExecutorTest is TestBase {
    uint256 internal constant WAD = 1e18;
    uint24 internal constant POOL_FEE = 3000;
    uint24 internal constant SWAP_PATH_FEE = 500;
    uint256 internal constant QUOTE_TOKEN_SCALE = 1e12;
    uint256 internal constant QUOTE_TOKEN_RAW = 50 * 1e6;
    uint256 internal constant QUOTE_TOKEN_WAD = QUOTE_TOKEN_RAW * QUOTE_TOKEN_SCALE;

    MockERC20 internal ajna;
    MockERC20 internal quote;
    MockSwapRouter internal router;
    MockAjnaPool internal ajnaPool;
    MockUniswapV3Factory internal factory;
    MockUniswapV3Factory internal rogueFactory;
    MockUniswapV3Pool internal flashPool;
    FlashArbExecutor internal executor;

    address internal profitRecipient = address(0xBEEF);

    function _swapPath(uint24 fee) internal view returns (bytes memory) {
        return _swapPathFor(address(quote), fee, address(ajna));
    }

    function _swapPathFor(
        address tokenIn,
        uint24 fee,
        address tokenOut
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(tokenIn, fee, tokenOut);
    }

    function setUp() public {
        ajna = new MockERC20("Ajna", "AJNA");
        quote = new MockERC20("Quote", "QUOTE");
        router = new MockSwapRouter(address(quote), address(ajna));
        factory = new MockUniswapV3Factory();
        rogueFactory = new MockUniswapV3Factory();
        executor = new FlashArbExecutor(
            address(ajna),
            address(router),
            address(factory),
            keccak256(type(MockUniswapV3Pool).creationCode)
        );
        ajnaPool = new MockAjnaPool(address(ajna), address(quote), QUOTE_TOKEN_SCALE, 2 * WAD);
        flashPool = MockUniswapV3Pool(
            factory.createPool(address(ajna), address(quote), POOL_FEE, 1 * WAD, 0)
        );

        ajna.mint(address(flashPool), 200 * WAD);
        quote.mint(address(ajnaPool), QUOTE_TOKEN_RAW);
        ajna.mint(address(router), 105 * WAD);
    }

    function test_executeFlashArb_repaysFlashLoanAndTransfersProfit() public {
        router.setNextAmountOut(105 * WAD);

        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(flashPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 100 * WAD,
            quoteAmount: QUOTE_TOKEN_WAD,
            swapPath: _swapPath(SWAP_PATH_FEE),
            minAjnaOut: 104 * WAD,
            profitRecipient: profitRecipient
        });

        executor.executeFlashArb(params);

        assertEq(ajna.balanceOf(address(flashPool)), 201 * WAD, "flash pool repaid with fee");
        assertEq(quote.balanceOf(address(router)), QUOTE_TOKEN_RAW, "router received raw quote");
        assertEq(ajna.balanceOf(profitRecipient), 4 * WAD, "profit recipient received profit");
        assertEq(ajna.balanceOf(address(ajnaPool)), 100 * WAD, "ajna pool burned borrowed ajna");
        assertEq(router.lastAmountIn(), QUOTE_TOKEN_RAW, "router swap consumed raw quote amount");
    }

    function test_executeFlashArb_keepsPreExistingAjnaAndEmitsRawQuoteAmount() public {
        router.setNextAmountOut(105 * WAD);
        ajna.mint(address(executor), 7 * WAD);

        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(flashPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 100 * WAD,
            quoteAmount: QUOTE_TOKEN_WAD,
            swapPath: _swapPath(SWAP_PATH_FEE),
            minAjnaOut: 104 * WAD,
            profitRecipient: profitRecipient
        });

        vm.recordLogs();
        executor.executeFlashArb(params);

        Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "should emit a single flash-arb event");

        (uint256 quoteTokenAmount, uint256 borrowedAjna, uint256 repaidAjna, uint256 profitAjna) =
            abi.decode(logs[0].data, (uint256, uint256, uint256, uint256));

        assertEq(quoteTokenAmount, QUOTE_TOKEN_RAW, "event should emit raw quote token units");
        assertEq(borrowedAjna, 100 * WAD, "event should emit borrowed ajna");
        assertEq(repaidAjna, 101 * WAD, "event should emit repaid ajna");
        assertEq(profitAjna, 4 * WAD, "event should emit only trade profit");
        assertEq(ajna.balanceOf(address(executor)), 7 * WAD, "pre-existing ajna should remain in executor");
        assertEq(ajna.balanceOf(profitRecipient), 4 * WAD, "profit recipient should receive only trade profit");
    }

    function test_executeFlashArb_revertsWhenFlashPoolUnderDelivers() public {
        // Deploy an under-delivering factory + pool and a fresh executor whose
        // canonical-pool verification is deliberately pinned to the under-delivering
        // pool's init code. This isolates the balance-delta check as the unit under
        // test: the canonical check passes (by configuration), and the ONLY remaining
        // defense against the pool draining pre-existing AJNA is
        // `startingAjnaBalance - preFlashAjnaBalance >= borrowAmount`.
        MockUnderdeliveringUniswapV3Factory underdeliveringFactory =
            new MockUnderdeliveringUniswapV3Factory();
        FlashArbExecutor underdeliveringExecutor = new FlashArbExecutor(
            address(ajna),
            address(router),
            address(underdeliveringFactory),
            keccak256(type(MockUnderdeliveringUniswapV3Pool).creationCode)
        );

        uint256 borrowAmount = 100 * WAD;
        uint256 shortfall = 1 * WAD;
        MockUnderdeliveringUniswapV3Pool underdeliveringPool = MockUnderdeliveringUniswapV3Pool(
            underdeliveringFactory.createPool(
                address(ajna),
                address(quote),
                POOL_FEE,
                1 * WAD, // fee0
                0,
                shortfall
            )
        );

        // Pool needs enough AJNA to transfer the (reduced) flash amount.
        ajna.mint(address(underdeliveringPool), borrowAmount);
        // Pre-existing AJNA in executor — the very balance a lazy check would
        // silently let the pool drain.
        ajna.mint(address(underdeliveringExecutor), 50 * WAD);

        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(underdeliveringPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: borrowAmount,
            quoteAmount: QUOTE_TOKEN_WAD,
            swapPath: _swapPath(SWAP_PATH_FEE),
            minAjnaOut: 104 * WAD,
            profitRecipient: profitRecipient
        });

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutorBase.InvalidBorrowBalance.selector));
        underdeliveringExecutor.executeFlashArb(params);

        // Pre-existing balance must remain untouched after the revert.
        assertEq(
            ajna.balanceOf(address(underdeliveringExecutor)),
            50 * WAD,
            "pre-existing AJNA must not be drained by under-delivery"
        );
    }

    function test_executeFlashArb_repaysWhenAjnaIsToken1() public {
        router.setNextAmountOut(105 * WAD);

        MockUniswapV3Pool token1AjnaPool = MockUniswapV3Pool(
            factory.createPool(address(quote), address(ajna), POOL_FEE, 0, 1 * WAD)
        );
        ajna.mint(address(token1AjnaPool), 200 * WAD);

        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(token1AjnaPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 100 * WAD,
            quoteAmount: QUOTE_TOKEN_WAD,
            swapPath: _swapPath(SWAP_PATH_FEE),
            minAjnaOut: 104 * WAD,
            profitRecipient: profitRecipient
        });

        executor.executeFlashArb(params);

        assertEq(ajna.balanceOf(address(token1AjnaPool)), 201 * WAD, "token1 flash pool repaid with fee");
        assertEq(quote.balanceOf(address(router)), QUOTE_TOKEN_RAW, "router received raw quote");
        assertEq(ajna.balanceOf(profitRecipient), 4 * WAD, "profit recipient received profit");
    }

    function test_uniswapV3FlashCallback_revertsWhenCallbackWasNotAuthorizedByOwner() public {
        router.setNextAmountOut(105 * WAD);

        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(flashPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 100 * WAD,
            quoteAmount: QUOTE_TOKEN_WAD,
            swapPath: _swapPath(SWAP_PATH_FEE),
            minAjnaOut: 104 * WAD,
            profitRecipient: profitRecipient
        });

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutorBase.UnauthorizedCallback.selector));
        flashPool.flash(address(executor), 100 * WAD, 0, abi.encode(params));
    }

    function test_uniswapV3FlashCallback_revertsForNonPoolCaller() public {
        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(flashPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 1,
            quoteAmount: 1,
            swapPath: hex"01",
            minAjnaOut: 1,
            profitRecipient: profitRecipient
        });

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutorBase.UnauthorizedCallback.selector));
        executor.uniswapV3FlashCallback(0, 0, abi.encode(params));
    }

    function test_executeFlashArb_revertsWhenSwapOutputCannotRepay() public {
        router.setNextAmountOut(100 * WAD);

        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(flashPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 100 * WAD,
            quoteAmount: QUOTE_TOKEN_WAD,
            swapPath: _swapPath(SWAP_PATH_FEE),
            minAjnaOut: 100 * WAD,
            profitRecipient: profitRecipient
        });

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutorBase.InsufficientRepayment.selector));
        executor.executeFlashArb(params);
    }

    function test_executeFlashArb_revertsForUnsupportedBorrowToken() public {
        MockERC20 other = new MockERC20("Other", "OTHER");
        MockUniswapV3Pool badPool = MockUniswapV3Pool(
            rogueFactory.createPool(address(other), address(quote), POOL_FEE, 0, 0)
        );

        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(badPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 1,
            quoteAmount: 1,
            swapPath: hex"01",
            minAjnaOut: 1,
            profitRecipient: profitRecipient
        });

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutorBase.UnsupportedBorrowToken.selector));
        executor.executeFlashArb(params);
    }

    function test_executeFlashArb_revertsForNonCanonicalFactoryPool() public {
        router.setNextAmountOut(105 * WAD);

        MockUniswapV3Pool roguePool = MockUniswapV3Pool(
            rogueFactory.createPool(address(ajna), address(quote), POOL_FEE, 1 * WAD, 0)
        );
        ajna.mint(address(roguePool), 200 * WAD);

        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(roguePool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 100 * WAD,
            quoteAmount: QUOTE_TOKEN_WAD,
            swapPath: _swapPath(SWAP_PATH_FEE),
            minAjnaOut: 104 * WAD,
            profitRecipient: profitRecipient
        });

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutor.InvalidFactoryPool.selector));
        executor.executeFlashArb(params);
    }

    function test_executeFlashArb_revertsForMalformedFlashPool() public {
        MockMalformedAjnaPool malformedPool = new MockMalformedAjnaPool(
            address(quote),
            QUOTE_TOKEN_SCALE,
            QUOTE_TOKEN_WAD
        );

        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(malformedPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 1,
            quoteAmount: 1,
            swapPath: hex"01",
            minAjnaOut: 1,
            profitRecipient: profitRecipient
        });

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutor.InvalidFlashPool.selector));
        executor.executeFlashArb(params);
    }

    function test_executeFlashArb_onlyOwner() public {
        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(flashPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 1,
            quoteAmount: 1,
            swapPath: hex"01",
            minAjnaOut: 1,
            profitRecipient: profitRecipient
        });

        vm.prank(address(0xCAFE));
        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutorBase.Unauthorized.selector));
        executor.executeFlashArb(params);
    }

    function test_executeFlashArb_revertsForZeroProfitRecipient() public {
        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(flashPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 1,
            quoteAmount: 1,
            swapPath: hex"01",
            minAjnaOut: 1,
            profitRecipient: address(0)
        });

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutorBase.InvalidAddress.selector));
        executor.executeFlashArb(params);
    }

    function test_executeFlashArb_revertsForZeroBorrowAmount() public {
        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(flashPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 0,
            quoteAmount: 1,
            swapPath: hex"01",
            minAjnaOut: 1,
            profitRecipient: profitRecipient
        });

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutorBase.InvalidParams.selector));
        executor.executeFlashArb(params);
    }

    function test_executeFlashArb_revertsForZeroQuoteAmount() public {
        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(flashPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 1,
            quoteAmount: 0,
            swapPath: hex"01",
            minAjnaOut: 1,
            profitRecipient: profitRecipient
        });

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutorBase.InvalidParams.selector));
        executor.executeFlashArb(params);
    }

    function test_executeFlashArb_revertsForEmptySwapPath() public {
        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(flashPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 1,
            quoteAmount: 1,
            swapPath: "",
            minAjnaOut: 1,
            profitRecipient: profitRecipient
        });

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutorBase.InvalidParams.selector));
        executor.executeFlashArb(params);
    }

    function test_recoverToken_transfersStrandedTokens() public {
        MockERC20 stranded = new MockERC20("Stranded", "STR");
        stranded.mint(address(executor), 123);

        executor.recoverToken(address(stranded), profitRecipient, 123);

        assertEq(stranded.balanceOf(address(executor)), 0, "executor should not retain stranded tokens");
        assertEq(stranded.balanceOf(profitRecipient), 123, "recipient should receive recovered tokens");
    }

    function test_recoverToken_onlyOwner() public {
        MockERC20 stranded = new MockERC20("Stranded", "STR");
        stranded.mint(address(executor), 123);

        vm.prank(address(0xCAFE));
        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutorBase.Unauthorized.selector));
        executor.recoverToken(address(stranded), profitRecipient, 123);
    }

    function test_recoverToken_revertsDuringActiveFlashExecution() public {
        MockERC20 localAjna = new MockERC20("Ajna", "AJNA");
        MockERC20 localQuote = new MockERC20("Quote", "QUOTE");
        MockERC20 stranded = new MockERC20("Stranded", "STR");
        MockUniswapV3Factory localFactory = new MockUniswapV3Factory();
        OwnerProxy ownerProxy = new OwnerProxy();

        ReenteringRecoverRouter reenteringRouter = new ReenteringRecoverRouter(
            address(localQuote),
            address(localAjna),
            ownerProxy
        );

        FlashArbExecutor proxyOwnedExecutor = ownerProxy.deployExecutor(
            address(localAjna),
            address(reenteringRouter),
            address(localFactory),
            keccak256(type(MockUniswapV3Pool).creationCode)
        );
        reenteringRouter.setExecutor(proxyOwnedExecutor);

        MockAjnaPool localAjnaPool = new MockAjnaPool(address(localAjna), address(localQuote), QUOTE_TOKEN_SCALE, 2 * WAD);
        MockUniswapV3Pool localFlashPool = MockUniswapV3Pool(
            localFactory.createPool(address(localAjna), address(localQuote), POOL_FEE, 1 * WAD, 0)
        );

        localAjna.mint(address(localFlashPool), 200 * WAD);
        localQuote.mint(address(localAjnaPool), QUOTE_TOKEN_RAW);
        localAjna.mint(address(reenteringRouter), 105 * WAD);
        stranded.mint(address(proxyOwnedExecutor), 9);

        reenteringRouter.setNextAmountOut(105 * WAD);
        reenteringRouter.setRecovery(address(stranded), profitRecipient, 9);

        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(localFlashPool),
            ajnaPool: address(localAjnaPool),
            borrowAmount: 100 * WAD,
            quoteAmount: QUOTE_TOKEN_WAD,
            swapPath: _swapPathFor(address(localQuote), SWAP_PATH_FEE, address(localAjna)),
            minAjnaOut: 104 * WAD,
            profitRecipient: profitRecipient
        });

        ownerProxy.executeFlashArb(proxyOwnedExecutor, params);

        assertTrue(reenteringRouter.recoveryAttempted(), "router should try recovery during callback");
        assertTrue(!reenteringRouter.recoverySucceeded(), "recovery should fail while flash execution is active");
        assertEq(stranded.balanceOf(address(proxyOwnedExecutor)), 9, "executor should retain stranded tokens");
        assertEq(stranded.balanceOf(profitRecipient), 0, "recipient should not receive stranded tokens");
    }

    function test_isCanonicalFactoryPool_returnsFalseForEOA() public view {
        assertTrue(
            !executor.isCanonicalFactoryPool(address(0x1234)),
            "non-contract address should not be treated as canonical pool"
        );
    }

    function test_isCanonicalFactoryPool_returnsFalseForMalformedContract() public {
        MockMalformedAjnaPool malformedPool = new MockMalformedAjnaPool(
            address(quote),
            QUOTE_TOKEN_SCALE,
            QUOTE_TOKEN_WAD
        );

        assertTrue(
            !executor.isCanonicalFactoryPool(address(malformedPool)),
            "malformed contract should not be treated as canonical pool"
        );
    }

    function test_executeFlashArb_revertsForNonIntegralQuoteAmount() public {
        router.setNextAmountOut(105 * WAD);
        MockMalformedAjnaPool malformedPool = new MockMalformedAjnaPool(
            address(quote),
            QUOTE_TOKEN_SCALE,
            QUOTE_TOKEN_WAD + 1
        );

        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(flashPool),
            ajnaPool: address(malformedPool),
            borrowAmount: 100 * WAD,
            quoteAmount: QUOTE_TOKEN_WAD,
            swapPath: _swapPath(SWAP_PATH_FEE),
            minAjnaOut: 104 * WAD,
            profitRecipient: profitRecipient
        });

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutorBase.InvalidQuoteAmount.selector));
        executor.executeFlashArb(params);
    }

    function test_executeFlashArb_revertsWhenSwapPathReusesFlashPool() public {
        router.setNextAmountOut(105 * WAD);

        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(flashPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 100 * WAD,
            quoteAmount: QUOTE_TOKEN_WAD,
            swapPath: _swapPath(POOL_FEE),
            minAjnaOut: 104 * WAD,
            profitRecipient: profitRecipient
        });

        vm.expectRevert(
            abi.encodeWithSelector(FlashArbExecutor.FlashPoolReuseInSwapPath.selector)
        );
        executor.executeFlashArb(params);
    }

    function test_executeFlashArb_revertsWhenSwapPathDoesNotStartWithQuoteToken() public {
        router.setNextAmountOut(105 * WAD);

        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(flashPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 100 * WAD,
            quoteAmount: QUOTE_TOKEN_WAD,
            swapPath: abi.encodePacked(address(ajna), SWAP_PATH_FEE, address(quote)),
            minAjnaOut: 104 * WAD,
            profitRecipient: profitRecipient
        });

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutorBase.InvalidSwapPath.selector));
        executor.executeFlashArb(params);
    }

    function test_executeFlashArb_revertsOnReentrantCall() public {
        // The nonReentrant modifier on executeFlashArb should reject a nested
        // call triggered during the flash callback. Here a malicious router
        // calls back into ownerProxy.executeFlashArb during exactInput.
        MockERC20 localAjna = new MockERC20("Ajna", "AJNA");
        MockERC20 localQuote = new MockERC20("Quote", "QUOTE");
        MockUniswapV3Factory localFactory = new MockUniswapV3Factory();
        OwnerProxy ownerProxy = new OwnerProxy();

        ReenteringExecuteRouter reenteringRouter = new ReenteringExecuteRouter(
            address(localQuote),
            address(localAjna),
            ownerProxy
        );

        FlashArbExecutor proxyOwnedExecutor = ownerProxy.deployExecutor(
            address(localAjna),
            address(reenteringRouter),
            address(localFactory),
            keccak256(type(MockUniswapV3Pool).creationCode)
        );
        reenteringRouter.setExecutor(proxyOwnedExecutor);

        MockAjnaPool localAjnaPool = new MockAjnaPool(
            address(localAjna),
            address(localQuote),
            QUOTE_TOKEN_SCALE,
            2 * WAD
        );
        MockUniswapV3Pool localFlashPool = MockUniswapV3Pool(
            localFactory.createPool(address(localAjna), address(localQuote), POOL_FEE, 1 * WAD, 0)
        );

        localAjna.mint(address(localFlashPool), 200 * WAD);
        localQuote.mint(address(localAjnaPool), QUOTE_TOKEN_RAW);
        localAjna.mint(address(reenteringRouter), 105 * WAD);

        reenteringRouter.setNextAmountOut(105 * WAD);

        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(localFlashPool),
            ajnaPool: address(localAjnaPool),
            borrowAmount: 100 * WAD,
            quoteAmount: QUOTE_TOKEN_WAD,
            swapPath: _swapPathFor(address(localQuote), SWAP_PATH_FEE, address(localAjna)),
            minAjnaOut: 104 * WAD,
            profitRecipient: profitRecipient
        });
        reenteringRouter.setRecursiveParams(params);

        ownerProxy.executeFlashArb(proxyOwnedExecutor, params);

        assertTrue(reenteringRouter.recursiveAttempted(), "router should attempt recursive execute");
        assertTrue(
            !reenteringRouter.recursiveSucceeded(),
            "recursive executeFlashArb must be rejected by nonReentrant guard"
        );
    }

    function test_safeTokenCall_acceptsNonStandardTokenReturn() public {
        // USDT-style token (approve/transfer return no data) must flow through
        // `_safeTokenCall`'s length==0 success branch. Exercised via recoverToken,
        // which routes _transferToken → _safeTokenCall on the provided token.
        MockNonStandardERC20 nsToken = new MockNonStandardERC20("Non-Standard", "NS");
        nsToken.mint(address(executor), 42);

        executor.recoverToken(address(nsToken), profitRecipient, 42);

        assertEq(
            nsToken.balanceOf(profitRecipient),
            42,
            "non-standard token should transfer successfully via _safeTokenCall"
        );
    }

    function test_safeTokenCall_rejectsFalseReturningToken() public {
        // Malicious token that returns `false` from transfer must be caught by
        // `_safeTokenCall`'s `returnData.length > 0 && !decoded-bool` branch and
        // revert with InvalidAddress — silently accepting the failure would be
        // unsafe. Exercised via recoverToken → _transferToken → _safeTokenCall.
        MockFalseReturningERC20 frToken = new MockFalseReturningERC20("False", "FR");
        frToken.mint(address(executor), 42);

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutorBase.InvalidAddress.selector));
        executor.recoverToken(address(frToken), profitRecipient, 42);
    }

    function test_executeFlashArb_revokesResidualAjnaApprovalToAjnaPool() public {
        // Use an Ajna pool whose auction price is below 1:1 (ajnaPerQuoteWad = 1
        // vs the default 2), so takeReserves pulls only HALF the approved
        // borrowAmount. Without the post-takeReserves revoke, the leftover
        // allowance would be exploitable by a malicious/later-compromised pool
        // calling transferFrom to drain pre-existing AJNA in a later tx.
        MockAjnaPool underPullingAjnaPool = new MockAjnaPool(
            address(ajna),
            address(quote),
            QUOTE_TOKEN_SCALE,
            1 * WAD
        );
        quote.mint(address(underPullingAjnaPool), QUOTE_TOKEN_RAW);
        router.setNextAmountOut(105 * WAD);

        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(flashPool),
            ajnaPool: address(underPullingAjnaPool),
            borrowAmount: 100 * WAD, // approve 100
            quoteAmount: QUOTE_TOKEN_WAD, // cost = 50 (ajnaPerQuoteWad = 1)
            swapPath: _swapPath(SWAP_PATH_FEE),
            minAjnaOut: 51 * WAD,
            profitRecipient: profitRecipient
        });

        executor.executeFlashArb(params);

        assertEq(
            ajna.allowance(address(executor), address(underPullingAjnaPool)),
            0,
            "executor must revoke residual AJNA allowance after takeReserves under-pull"
        );
        assertEq(
            quote.allowance(address(executor), address(router)),
            0,
            "executor must revoke residual quote allowance after swap"
        );
    }

    function test_recoverToken_revertsForEoaToken() public {
        // `_safeTokenCall` now requires the token to have deployed code —
        // calling `approve`/`transfer` on an EOA succeeds silently with empty
        // return data and would otherwise be indistinguishable from a
        // legitimate non-standard-token success.
        address eoaToken = address(0x1234);
        assertTrue(eoaToken.code.length == 0, "sanity: 0x1234 must be an EOA");

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutorBase.InvalidAddress.selector));
        executor.recoverToken(eoaToken, profitRecipient, 1);
    }
}
