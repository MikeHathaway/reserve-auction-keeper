// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20Like} from "../../FlashArbExecutorBase.sol";
import {IUniswapV2Callee} from "../../FlashArbExecutorV2V3.sol";

// Test-only mock for a malicious / misbehaving Uniswap V2 pair that swap()s
// FEWER tokens than requested. The partnering factory registers the pair address
// via getPair so the executor's canonical-pair verification passes.
contract MockUnderdeliveringUniswapV2Pair {
    address public immutable token0;
    address public immutable token1;
    uint256 public immutable shortfall;

    constructor(address token0_, address token1_, uint256 shortfall_) {
        token0 = token0_;
        token1 = token1_;
        shortfall = shortfall_;
    }

    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast) {
        reserve0 = uint112(IERC20Like(token0).balanceOf(address(this)));
        reserve1 = uint112(IERC20Like(token1).balanceOf(address(this)));
        blockTimestampLast = 0;
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external {
        uint256 delivered0 = amount0Out >= shortfall ? amount0Out - shortfall : 0;
        uint256 delivered1 = amount1Out >= shortfall ? amount1Out - shortfall : 0;

        if (delivered0 > 0) {
            require(IERC20Like(token0).transfer(to, delivered0), "SWAP0");
        }
        if (delivered1 > 0) {
            require(IERC20Like(token1).transfer(to, delivered1), "SWAP1");
        }

        if (data.length > 0) {
            // Pass the REQUESTED amounts to the callback (matches real UniV2 behavior
            // where the callback receives amount0Out/amount1Out, not what was
            // actually transferred in fee-on-transfer edge cases).
            IUniswapV2Callee(to).uniswapV2Call(msg.sender, amount0Out, amount1Out, data);
        }
        // No post-callback balance check — the executor is expected to revert
        // before the callback completes.
    }
}

contract MockUnderdeliveringUniswapV2Factory {
    mapping(address => mapping(address => address)) public getPair;

    function createUnderdeliveringPair(
        address tokenA,
        address tokenB,
        uint256 shortfall
    ) external returns (address pair) {
        require(tokenA != tokenB, "IDENTICAL");
        (address token0, address token1) =
            tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);

        MockUnderdeliveringUniswapV2Pair createdPair = new MockUnderdeliveringUniswapV2Pair(
            token0,
            token1,
            shortfall
        );
        pair = address(createdPair);
        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair;
    }
}
