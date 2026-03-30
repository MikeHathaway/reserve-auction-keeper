// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FlashArbExecutor} from "../FlashArbExecutor.sol";
import {TestBase} from "./TestBase.sol";
import {MockUniswapV3Factory} from "./mocks/MockUniswapV3Factory.sol";
import {MockUniswapV3Pool} from "./mocks/MockUniswapV3Pool.sol";

contract FlashArbExecutorMainnetForkTest is TestBase {
    address internal constant MAINNET_UNISWAP_V3_FACTORY =
        0x1F98431c8aD98523631AE4a59f267346ea31F984;
    bytes32 internal constant MAINNET_UNISWAP_V3_POOL_INIT_CODE_HASH =
        0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54;
    address internal constant MAINNET_USDC_WETH_3000_POOL =
        0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8;
    address internal constant MAINNET_AJNA =
        0x9a96ec9B57Fb64FbC60B423d1f4da7691Bd35079;

    function test_mainnetCanonicalPoolVerificationMatchesRealUniswapPool() public {
        FlashArbExecutor executor = new FlashArbExecutor(
            MAINNET_AJNA,
            address(0x1111111111111111111111111111111111111111),
            MAINNET_UNISWAP_V3_FACTORY,
            MAINNET_UNISWAP_V3_POOL_INIT_CODE_HASH
        );

        assertTrue(
            executor.isCanonicalFactoryPool(MAINNET_USDC_WETH_3000_POOL),
            "known mainnet Uniswap V3 pool should validate against factory + init code hash"
        );
    }

    function test_mainnetCanonicalPoolVerificationRejectsRogueFactoryPool() public {
        MockUniswapV3Factory rogueFactory = new MockUniswapV3Factory();
        MockUniswapV3Pool roguePool = MockUniswapV3Pool(
            rogueFactory.createPool(
                MAINNET_AJNA,
                0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48,
                3000,
                0,
                0
            )
        );

        FlashArbExecutor executor = new FlashArbExecutor(
            MAINNET_AJNA,
            address(0x1111111111111111111111111111111111111111),
            MAINNET_UNISWAP_V3_FACTORY,
            MAINNET_UNISWAP_V3_POOL_INIT_CODE_HASH
        );

        assertTrue(
            !executor.isCanonicalFactoryPool(address(roguePool)),
            "pool deployed from rogue factory must fail canonical verification"
        );
    }
}
