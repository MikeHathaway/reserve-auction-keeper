// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

contract MockMalformedAjnaPool {
    address public immutable quoteTokenAddress;
    uint256 public immutable quoteTokenScale;
    uint256 public immutable returnedQuoteAmount;

    constructor(address quoteToken_, uint256 quoteTokenScale_, uint256 returnedQuoteAmount_) {
        quoteTokenAddress = quoteToken_;
        quoteTokenScale = quoteTokenScale_;
        returnedQuoteAmount = returnedQuoteAmount_;
    }

    function takeReserves(uint256) external view returns (uint256) {
        return returnedQuoteAmount;
    }
}
