// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FlashArbExecutorV2V3} from "../FlashArbExecutorV2V3.sol";
import {FlashArbExecutorBase} from "../FlashArbExecutorBase.sol";
import {Log, TestBase} from "./TestBase.sol";
import {MockAjnaPool} from "./mocks/MockAjnaPool.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockMalformedAjnaPool} from "./mocks/MockMalformedAjnaPool.sol";
import {MockSwapRouter} from "./mocks/MockSwapRouter.sol";
import {MockUniswapV2Factory} from "./mocks/MockUniswapV2Factory.sol";
import {MockUniswapV2Pair} from "./mocks/MockUniswapV2Pair.sol";
import {
    MockUnderdeliveringUniswapV2Factory,
    MockUnderdeliveringUniswapV2Pair
} from "./mocks/MockUnderdeliveringUniswapV2Pair.sol";

contract FlashArbExecutorV2V3Test is TestBase {
    uint256 internal constant WAD = 1e18;
    uint24 internal constant SWAP_PATH_FEE = 500;
    uint256 internal constant QUOTE_TOKEN_SCALE = 1e12;
    uint256 internal constant QUOTE_TOKEN_RAW = 50 * 1e6;
    uint256 internal constant QUOTE_TOKEN_WAD = QUOTE_TOKEN_RAW * QUOTE_TOKEN_SCALE;

    MockERC20 internal ajna;
    MockERC20 internal quote;
    MockSwapRouter internal router;
    MockAjnaPool internal ajnaPool;
    MockUniswapV2Factory internal factory;
    MockUniswapV2Factory internal rogueFactory;
    MockUniswapV2Pair internal flashPair;
    FlashArbExecutorV2V3 internal executor;

    address internal profitRecipient = address(0xBEEF);

    function _repayAmount(uint256 borrowAmount) internal pure returns (uint256) {
        return (borrowAmount * 1000 + 996) / 997;
    }

    function _swapPath() internal view returns (bytes memory) {
        return abi.encodePacked(address(quote), SWAP_PATH_FEE, address(ajna));
    }

    function setUp() public {
        ajna = new MockERC20("Ajna", "AJNA");
        quote = new MockERC20("Quote", "QUOTE");
        router = new MockSwapRouter(address(quote), address(ajna));
        factory = new MockUniswapV2Factory();
        rogueFactory = new MockUniswapV2Factory();
        executor = new FlashArbExecutorV2V3(
            address(ajna),
            address(router),
            address(factory)
        );
        ajnaPool = new MockAjnaPool(address(ajna), address(quote), QUOTE_TOKEN_SCALE, 2 * WAD);
        flashPair = MockUniswapV2Pair(factory.createPair(address(ajna), address(quote)));

        ajna.mint(address(flashPair), 200 * WAD);
        quote.mint(address(ajnaPool), QUOTE_TOKEN_RAW);
        ajna.mint(address(router), 105 * WAD);
    }

    function test_executeFlashArb_repaysFlashSwapAndTransfersProfit() public {
        router.setNextAmountOut(105 * WAD);

        FlashArbExecutorV2V3.ExecuteParams memory params = FlashArbExecutorV2V3.ExecuteParams({
            flashPair: address(flashPair),
            ajnaPool: address(ajnaPool),
            borrowAmount: 100 * WAD,
            quoteAmount: QUOTE_TOKEN_WAD,
            swapPath: _swapPath(),
            minAjnaOut: 104 * WAD,
            profitRecipient: profitRecipient
        });

        executor.executeFlashArb(params);

        assertEq(ajna.balanceOf(address(flashPair)), 100 * WAD + _repayAmount(100 * WAD), "flash pair repaid with fee");
        assertEq(quote.balanceOf(address(router)), QUOTE_TOKEN_RAW, "router received raw quote");
        assertEq(ajna.balanceOf(profitRecipient), 105 * WAD - _repayAmount(100 * WAD), "profit recipient received profit");
    }

    function test_executeFlashArb_keepsPreExistingAjnaAndEmitsRawQuoteAmount() public {
        router.setNextAmountOut(105 * WAD);
        ajna.mint(address(executor), 7 * WAD);

        FlashArbExecutorV2V3.ExecuteParams memory params = FlashArbExecutorV2V3.ExecuteParams({
            flashPair: address(flashPair),
            ajnaPool: address(ajnaPool),
            borrowAmount: 100 * WAD,
            quoteAmount: QUOTE_TOKEN_WAD,
            swapPath: _swapPath(),
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
        assertEq(repaidAjna, _repayAmount(100 * WAD), "event should emit repaid ajna");
        assertEq(profitAjna, 105 * WAD - _repayAmount(100 * WAD), "event should emit only trade profit");
        assertEq(ajna.balanceOf(address(executor)), 7 * WAD, "pre-existing ajna should remain in executor");
    }

    function test_uniswapV2Call_revertsForNonPairCaller() public {
        FlashArbExecutorV2V3.ExecuteParams memory params = FlashArbExecutorV2V3.ExecuteParams({
            flashPair: address(flashPair),
            ajnaPool: address(ajnaPool),
            borrowAmount: 1,
            quoteAmount: 1,
            swapPath: hex"01",
            minAjnaOut: 1,
            profitRecipient: profitRecipient
        });

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutorBase.UnauthorizedCallback.selector));
        executor.uniswapV2Call(address(this), 1, 0, abi.encode(params));
    }

    function test_executeFlashArb_revertsForNonCanonicalFactoryPair() public {
        router.setNextAmountOut(105 * WAD);

        MockUniswapV2Pair roguePair = MockUniswapV2Pair(
            rogueFactory.createPair(address(ajna), address(quote))
        );
        ajna.mint(address(roguePair), 200 * WAD);

        FlashArbExecutorV2V3.ExecuteParams memory params = FlashArbExecutorV2V3.ExecuteParams({
            flashPair: address(roguePair),
            ajnaPool: address(ajnaPool),
            borrowAmount: 100 * WAD,
            quoteAmount: QUOTE_TOKEN_WAD,
            swapPath: _swapPath(),
            minAjnaOut: 104 * WAD,
            profitRecipient: profitRecipient
        });

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutorV2V3.InvalidFactoryPair.selector));
        executor.executeFlashArb(params);
    }

    function test_executeFlashArb_revertsWhenFlashPairUnderDelivers() public {
        // Fresh executor pointing at an under-delivering factory/pair: canonical-pair
        // verification passes (the factory's getPair registers the mock) but the pair
        // actually transfers LESS than requested. This isolates the balance-delta
        // check as the unit under test — the ONLY defense against the under-delivery
        // draining pre-existing AJNA is
        // `startingAjnaBalance - preFlashAjnaBalance >= borrowAmount`.
        MockUnderdeliveringUniswapV2Factory underdeliveringFactory =
            new MockUnderdeliveringUniswapV2Factory();
        FlashArbExecutorV2V3 underdeliveringExecutor = new FlashArbExecutorV2V3(
            address(ajna),
            address(router),
            address(underdeliveringFactory)
        );

        uint256 borrowAmount = 100 * WAD;
        uint256 shortfall = 1 * WAD;
        MockUnderdeliveringUniswapV2Pair underdeliveringPair = MockUnderdeliveringUniswapV2Pair(
            underdeliveringFactory.createUnderdeliveringPair(
                address(ajna),
                address(quote),
                shortfall
            )
        );

        ajna.mint(address(underdeliveringPair), borrowAmount);
        ajna.mint(address(underdeliveringExecutor), 50 * WAD);

        FlashArbExecutorV2V3.ExecuteParams memory params = FlashArbExecutorV2V3.ExecuteParams({
            flashPair: address(underdeliveringPair),
            ajnaPool: address(ajnaPool),
            borrowAmount: borrowAmount,
            quoteAmount: QUOTE_TOKEN_WAD,
            swapPath: _swapPath(),
            minAjnaOut: 104 * WAD,
            profitRecipient: profitRecipient
        });

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutorBase.InvalidBorrowBalance.selector));
        underdeliveringExecutor.executeFlashArb(params);

        assertEq(
            ajna.balanceOf(address(underdeliveringExecutor)),
            50 * WAD,
            "pre-existing AJNA must not be drained by under-delivery"
        );
    }

    function test_executeFlashArb_revertsWhenSwapPathDoesNotStartWithQuoteToken() public {
        router.setNextAmountOut(105 * WAD);

        FlashArbExecutorV2V3.ExecuteParams memory params = FlashArbExecutorV2V3.ExecuteParams({
            flashPair: address(flashPair),
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

    function test_executeFlashArb_onlyOwner() public {
        FlashArbExecutorV2V3.ExecuteParams memory params = FlashArbExecutorV2V3.ExecuteParams({
            flashPair: address(flashPair),
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
}
