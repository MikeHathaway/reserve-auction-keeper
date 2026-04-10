// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20Like} from "../../FlashArbExecutor.sol";
import {IUniswapV2Callee} from "../../FlashArbExecutorV2V3.sol";

contract MockUniswapV2Pair {
    address public immutable token0;
    address public immutable token1;

    constructor(address token0_, address token1_) {
        token0 = token0_;
        token1 = token1_;
    }

    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast) {
        reserve0 = uint112(IERC20Like(token0).balanceOf(address(this)));
        reserve1 = uint112(IERC20Like(token1).balanceOf(address(this)));
        blockTimestampLast = 0;
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external {
        uint256 token0Start = IERC20Like(token0).balanceOf(address(this));
        uint256 token1Start = IERC20Like(token1).balanceOf(address(this));

        if (amount0Out > 0) {
            require(IERC20Like(token0).transfer(to, amount0Out), "SWAP0");
        }
        if (amount1Out > 0) {
            require(IERC20Like(token1).transfer(to, amount1Out), "SWAP1");
        }

        if (data.length > 0) {
            IUniswapV2Callee(to).uniswapV2Call(msg.sender, amount0Out, amount1Out, data);
        }

        if (amount0Out > 0) {
            require(
                IERC20Like(token0).balanceOf(address(this)) >= token0Start + _expectedFee(amount0Out),
                "UNPAID0"
            );
        }
        if (amount1Out > 0) {
            require(
                IERC20Like(token1).balanceOf(address(this)) >= token1Start + _expectedFee(amount1Out),
                "UNPAID1"
            );
        }
    }

    function _expectedFee(uint256 amountOut) internal pure returns (uint256) {
        return ((amountOut * 1000 + 996) / 997) - amountOut;
    }
}
