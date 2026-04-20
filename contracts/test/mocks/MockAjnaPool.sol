// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20Like} from "../../FlashArbExecutorBase.sol";

contract MockAjnaPool {
    address public immutable ajnaToken;
    address public immutable quoteTokenAddress;
    uint256 public immutable quoteTokenScale;
    uint256 public immutable ajnaPerQuoteWad;

    uint256 public lastTakeAmount;

    constructor(
        address ajnaToken_,
        address quoteToken_,
        uint256 quoteTokenScale_,
        uint256 ajnaPerQuoteWad_
    ) {
        ajnaToken = ajnaToken_;
        quoteTokenAddress = quoteToken_;
        quoteTokenScale = quoteTokenScale_;
        ajnaPerQuoteWad = ajnaPerQuoteWad_;
    }

    function takeReserves(uint256 amount) external returns (uint256) {
        lastTakeAmount = amount;
        require(quoteTokenScale != 0 && amount % quoteTokenScale == 0, "QUOTE_SCALE");

        uint256 ajnaCost = (amount * ajnaPerQuoteWad) / 1e18;
        uint256 quoteTokenAmount = amount / quoteTokenScale;
        require(
            IERC20Like(ajnaToken).transferFrom(msg.sender, address(this), ajnaCost),
            "AJNA_TRANSFER"
        );
        require(
            IERC20Like(quoteTokenAddress).transfer(msg.sender, quoteTokenAmount),
            "QUOTE_TRANSFER"
        );

        return amount;
    }
}
