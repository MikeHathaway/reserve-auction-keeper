// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FlashArbExecutorV3V2} from "../FlashArbExecutorV3V2.sol";
import {InvariantBase, FuzzSelector} from "./InvariantBase.sol";
import {MockAjnaPool} from "./mocks/MockAjnaPool.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockUniswapV2Router} from "./mocks/MockUniswapV2Router.sol";
import {MockUniswapV3Factory} from "./mocks/MockUniswapV3Factory.sol";
import {MockUniswapV3Pool} from "./mocks/MockUniswapV3Pool.sol";

contract UnauthorizedFlashArbActorV3V2 {
    function tryUnauthorizedExecute(
        FlashArbExecutorV3V2 executor,
        FlashArbExecutorV3V2.ExecuteParams memory params
    ) external returns (bool) {
        try executor.executeFlashArb(params) {
            return true;
        } catch {
            return false;
        }
    }

    function tryUnauthorizedPoolCallback(
        MockUniswapV3Pool flashPool,
        address recipient,
        uint256 amount0,
        uint256 amount1,
        bytes memory data
    ) external returns (bool) {
        try flashPool.flash(recipient, amount0, amount1, data) {
            return true;
        } catch {
            return false;
        }
    }

    function tryUnauthorizedDirectCallback(
        FlashArbExecutorV3V2 executor,
        uint256 fee0,
        uint256 fee1,
        bytes memory data
    ) external returns (bool) {
        try executor.uniswapV3FlashCallback(fee0, fee1, data) {
            return true;
        } catch {
            return false;
        }
    }
}

contract FlashArbExecutorV3V2Handler {
    uint256 internal constant WAD = 1e18;
    uint24 internal constant POOL_FEE = 3000;
    uint256 internal constant FLASH_FEE = 1 * WAD;
    uint256 internal constant MAX_NORMALIZED_QUOTE = 5_000 * WAD;
    uint256 internal constant MAX_PROFIT = 25 * WAD;
    uint256 internal constant MAX_PRESEEDED = 25 * WAD;

    MockERC20 internal ajna;
    MockERC20 internal quote;
    MockUniswapV2Router internal router;
    MockAjnaPool internal ajnaPool;
    MockUniswapV3Factory internal factory;
    MockUniswapV3Pool internal flashPool;
    FlashArbExecutorV3V2 internal executor;
    UnauthorizedFlashArbActorV3V2 internal attacker;

    address internal constant PROFIT_RECIPIENT = address(0xBEEF);

    uint256 internal immutable quoteTokenScale;
    bool internal immutable ajnaIsToken0;

    uint256 internal expectedProfitRecipientBalance;
    uint256 internal expectedExecutorResidualBalance;
    uint256 internal expectedFlashPoolBalance;

    struct StateSnapshot {
        uint256 executorAjna;
        uint256 executorQuote;
        uint256 flashPoolAjna;
        uint256 flashPoolQuote;
        uint256 routerAjna;
        uint256 routerQuote;
        uint256 ajnaPoolAjna;
        uint256 ajnaPoolQuote;
        uint256 profitRecipientAjna;
    }

    constructor(uint256 quoteTokenScale_, bool ajnaIsToken0_) {
        quoteTokenScale = quoteTokenScale_;
        ajnaIsToken0 = ajnaIsToken0_;

        if (ajnaIsToken0_) {
            ajna = new MockERC20("Ajna", "AJNA");
            quote = new MockERC20("Quote", "QUOTE");
        } else {
            quote = new MockERC20("Quote", "QUOTE");
            ajna = new MockERC20("Ajna", "AJNA");
        }

        router = new MockUniswapV2Router(address(quote), address(ajna));
        factory = new MockUniswapV3Factory();
        attacker = new UnauthorizedFlashArbActorV3V2();
        executor = new FlashArbExecutorV3V2(
            address(ajna),
            address(router),
            address(factory),
            keccak256(type(MockUniswapV3Pool).creationCode)
        );
        ajnaPool = new MockAjnaPool(address(ajna), address(quote), quoteTokenScale, 2 * WAD);
        flashPool = ajnaIsToken0
            ? MockUniswapV3Pool(
                factory.createPool(address(ajna), address(quote), POOL_FEE, FLASH_FEE, 0)
            )
            : MockUniswapV3Pool(
                factory.createPool(address(quote), address(ajna), POOL_FEE, 0, FLASH_FEE)
            );

        ajna.mint(address(flashPool), 1_000_000_000 * WAD);
        quote.mint(address(ajnaPool), 1_000_000_000 * WAD);
        ajna.mint(address(router), 1_000_000_000 * WAD);

        expectedFlashPoolBalance = ajna.balanceOf(address(flashPool));
    }

    function executeScenario(
        uint96 normalizedQuoteSeed,
        uint96 profitSeed,
        uint96 preseededAjnaSeed
    ) external {
        uint256 quoteAmount = _normalizedQuoteAmount(normalizedQuoteSeed);
        uint256 borrowAmount = 2 * quoteAmount;
        uint256 profitAmount = _bound(profitSeed, 1, MAX_PROFIT);
        uint256 preseededAjna = _bound(preseededAjnaSeed, 0, MAX_PRESEEDED);

        if (preseededAjna > 0) {
            ajna.mint(address(executor), preseededAjna);
            expectedExecutorResidualBalance += preseededAjna;
        }

        router.setNextAmountOut(borrowAmount + FLASH_FEE + profitAmount);

        FlashArbExecutorV3V2.ExecuteParams memory params = FlashArbExecutorV3V2.ExecuteParams({
            flashPool: address(flashPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: borrowAmount,
            quoteAmount: quoteAmount,
            swapPath: _swapPath(),
            minAjnaOut: borrowAmount + FLASH_FEE + profitAmount,
            profitRecipient: PROFIT_RECIPIENT
        });

        executor.executeFlashArb(params);

        expectedProfitRecipientBalance += profitAmount;
        expectedFlashPoolBalance += FLASH_FEE;
    }

    function attemptUnauthorizedExecute(
        uint96 normalizedQuoteSeed,
        uint96 profitSeed
    ) external {
        FlashArbExecutorV3V2.ExecuteParams memory params = _buildParams(
            normalizedQuoteSeed,
            profitSeed
        );
        router.setNextAmountOut(params.minAjnaOut);
        StateSnapshot memory before = _snapshotState();
        bool success = attacker.tryUnauthorizedExecute(executor, params);
        require(!success, "unauthorized execute succeeded");
        _assertSnapshotUnchanged(before);
    }

    function attemptUnauthorizedPoolCallback(
        uint96 normalizedQuoteSeed,
        uint96 profitSeed
    ) external {
        FlashArbExecutorV3V2.ExecuteParams memory params = _buildParams(
            normalizedQuoteSeed,
            profitSeed
        );
        router.setNextAmountOut(params.minAjnaOut);
        StateSnapshot memory before = _snapshotState();
        (uint256 amount0, uint256 amount1) = _flashAmounts(params.borrowAmount);
        bool success = attacker.tryUnauthorizedPoolCallback(
            flashPool,
            address(executor),
            amount0,
            amount1,
            abi.encode(params)
        );
        require(!success, "unauthorized pool callback succeeded");
        _assertSnapshotUnchanged(before);
    }

    function attemptUnauthorizedDirectCallback(
        uint96 normalizedQuoteSeed,
        uint96 profitSeed
    ) external {
        FlashArbExecutorV3V2.ExecuteParams memory params = _buildParams(
            normalizedQuoteSeed,
            profitSeed
        );
        router.setNextAmountOut(params.minAjnaOut);
        StateSnapshot memory before = _snapshotState();
        (uint256 fee0, uint256 fee1) = _flashFees();
        bool success = attacker.tryUnauthorizedDirectCallback(
            executor,
            fee0,
            fee1,
            abi.encode(params)
        );
        require(!success, "unauthorized direct callback succeeded");
        _assertSnapshotUnchanged(before);
    }

    function profitRecipientBalance() external view returns (uint256) {
        return ajna.balanceOf(PROFIT_RECIPIENT);
    }

    function expectedProfitBalance() external view returns (uint256) {
        return expectedProfitRecipientBalance;
    }

    function executorResidualBalance() external view returns (uint256) {
        return ajna.balanceOf(address(executor));
    }

    function executorQuoteBalance() external view returns (uint256) {
        return quote.balanceOf(address(executor));
    }

    function expectedExecutorResidual() external view returns (uint256) {
        return expectedExecutorResidualBalance;
    }

    function flashPoolBalance() external view returns (uint256) {
        return ajna.balanceOf(address(flashPool));
    }

    function expectedFlashPoolAjnaBalance() external view returns (uint256) {
        return expectedFlashPoolBalance;
    }

    function _buildParams(
        uint96 normalizedQuoteSeed,
        uint96 profitSeed
    ) internal view returns (FlashArbExecutorV3V2.ExecuteParams memory params) {
        uint256 quoteAmount = _normalizedQuoteAmount(normalizedQuoteSeed);
        uint256 borrowAmount = 2 * quoteAmount;
        uint256 profitAmount = _bound(profitSeed, 1, MAX_PROFIT);

        params = FlashArbExecutorV3V2.ExecuteParams({
            flashPool: address(flashPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: borrowAmount,
            quoteAmount: quoteAmount,
            swapPath: _swapPath(),
            minAjnaOut: borrowAmount + FLASH_FEE + profitAmount,
            profitRecipient: PROFIT_RECIPIENT
        });
    }

    function _normalizedQuoteAmount(uint96 normalizedQuoteSeed) internal view returns (uint256 quoteAmount) {
        quoteAmount = _bound(normalizedQuoteSeed, quoteTokenScale, MAX_NORMALIZED_QUOTE);
        quoteAmount -= quoteAmount % quoteTokenScale;
        if (quoteAmount == 0) {
            quoteAmount = quoteTokenScale;
        }
    }

    function _swapPath() internal view returns (address[] memory path) {
        path = new address[](2);
        path[0] = address(quote);
        path[1] = address(ajna);
    }

    function _flashAmounts(uint256 borrowAmount) internal view returns (uint256 amount0, uint256 amount1) {
        if (ajnaIsToken0) {
            amount0 = borrowAmount;
        } else {
            amount1 = borrowAmount;
        }
    }

    function _flashFees() internal view returns (uint256 fee0, uint256 fee1) {
        if (ajnaIsToken0) {
            fee0 = FLASH_FEE;
        } else {
            fee1 = FLASH_FEE;
        }
    }

    function _snapshotState() internal view returns (StateSnapshot memory snapshot) {
        snapshot = StateSnapshot({
            executorAjna: ajna.balanceOf(address(executor)),
            executorQuote: quote.balanceOf(address(executor)),
            flashPoolAjna: ajna.balanceOf(address(flashPool)),
            flashPoolQuote: quote.balanceOf(address(flashPool)),
            routerAjna: ajna.balanceOf(address(router)),
            routerQuote: quote.balanceOf(address(router)),
            ajnaPoolAjna: ajna.balanceOf(address(ajnaPool)),
            ajnaPoolQuote: quote.balanceOf(address(ajnaPool)),
            profitRecipientAjna: ajna.balanceOf(PROFIT_RECIPIENT)
        });
    }

    function _assertSnapshotUnchanged(StateSnapshot memory before) internal view {
        require(ajna.balanceOf(address(executor)) == before.executorAjna, "executor ajna changed");
        require(quote.balanceOf(address(executor)) == before.executorQuote, "executor quote changed");
        require(ajna.balanceOf(address(flashPool)) == before.flashPoolAjna, "flash pool ajna changed");
        require(quote.balanceOf(address(flashPool)) == before.flashPoolQuote, "flash pool quote changed");
        require(ajna.balanceOf(address(router)) == before.routerAjna, "router ajna changed");
        require(quote.balanceOf(address(router)) == before.routerQuote, "router quote changed");
        require(ajna.balanceOf(address(ajnaPool)) == before.ajnaPoolAjna, "ajna pool ajna changed");
        require(quote.balanceOf(address(ajnaPool)) == before.ajnaPoolQuote, "ajna pool quote changed");
        require(ajna.balanceOf(PROFIT_RECIPIENT) == before.profitRecipientAjna, "profit recipient changed");
    }

    function _bound(
        uint256 value,
        uint256 min,
        uint256 max
    ) internal pure returns (uint256) {
        if (max <= min) return min;
        return min + (value % (max - min + 1));
    }
}

contract FlashArbExecutorV3V2InvariantTest is InvariantBase {
    FlashArbExecutorV3V2Handler[] internal handlers;

    function setUp() public {
        _registerHandler(new FlashArbExecutorV3V2Handler(1, true));
        _registerHandler(new FlashArbExecutorV3V2Handler(1, false));
        _registerHandler(new FlashArbExecutorV3V2Handler(1e12, false));
    }

    function _registerHandler(FlashArbExecutorV3V2Handler handler) internal {
        handlers.push(handler);
        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = handler.executeScenario.selector;
        selectors[1] = handler.attemptUnauthorizedExecute.selector;
        selectors[2] = handler.attemptUnauthorizedPoolCallback.selector;
        selectors[3] = handler.attemptUnauthorizedDirectCallback.selector;
        targetSelector(FuzzSelector({
            addr: address(handler),
            selectors: selectors
        }));
    }

    function invariant_profitRecipientOnlyReceivesTradeDelta() public view {
        for (uint256 i = 0; i < handlers.length; i++) {
            FlashArbExecutorV3V2Handler handler = handlers[i];
            assertEq(
                handler.profitRecipientBalance(),
                handler.expectedProfitBalance(),
                "profit recipient balance should equal cumulative trade profit only"
            );
        }
    }

    function invariant_executorKeepsOnlyPreseededAjna() public view {
        for (uint256 i = 0; i < handlers.length; i++) {
            FlashArbExecutorV3V2Handler handler = handlers[i];
            assertEq(
                handler.executorResidualBalance(),
                handler.expectedExecutorResidual(),
                "executor should retain only explicitly pre-seeded AJNA"
            );
        }
    }

    function invariant_executorDoesNotRetainQuoteTokens() public view {
        for (uint256 i = 0; i < handlers.length; i++) {
            FlashArbExecutorV3V2Handler handler = handlers[i];
            assertEq(
                handler.executorQuoteBalance(),
                0,
                "executor should not retain quote-token balances after successful runs"
            );
        }
    }

    function invariant_flashPoolNeverLosesPrincipal() public view {
        for (uint256 i = 0; i < handlers.length; i++) {
            FlashArbExecutorV3V2Handler handler = handlers[i];
            assertEq(
                handler.flashPoolBalance(),
                handler.expectedFlashPoolAjnaBalance(),
                "flash pool should keep principal and accrue exactly the configured fee"
            );
        }
    }
}
