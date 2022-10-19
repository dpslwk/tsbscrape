const u = require('./utils.js');

// Class for dealing with the Barclays account page.
module.exports = class Account {
  constructor(session, sortCode, number) {
    this.session = session;
    this.page = session.page;
    this.number = number;
    this.sortCode = sortCode;
    this.tracking = null
    this.lastDate = null
    this.pageCount = 0
  }

  async select() {
    // Switch the page to this account.
    // Call `await this.session.home()` to reset state when you're done.
    console.log('Selecting account ' + this.number);
    // await this.page.$eval('a[ng-click="goToStatements(data)"]', el => el.click());
    // await this.page.click('a[ng-click="goToStatements(data)"]');
    await this.page.evaluate(async function goToStatements() {
        function sleep(ms) {
          return new Promise(resolve => setTimeout(resolve, ms));
        }
        await sleep(10);
        angular.element(document.querySelector('a[ng-click="goToStatements(data)"]')).triggerHandler('click');
    });
    // waitForNavigation seems to stall indefinitely here (?!) so we don't use u.click
    await u.wait(this.page, '#statementComponentsId');
  }

  async statementCSV(conf) {
    await this.select();
    if (conf.has(this.number+'tracking')) {
      this.tracking = new Date(conf.get(this.number+'tracking'));
    } else {
      this.tracking = new Date();
      conf.set(this.number+'tracking', this.tracking);
    }
    this.lastDate = this.tracking.setHours(-24);
    console.log("Going back to: " + this.tracking)
    this.pageCount = 0;
    await this.page.waitForNavigation({waitUntil: 'networkidle0'})

    const allTransactions = await this.scrapeLoop();

    this.tracking = new Date(allTransactions[0].date);
    conf.set(this.number+'tracking', this.tracking);

    console.log("Finished scraping " + this.pageCount + " pages, " + allTransactions.length + " transactions");

    return allTransactions;
  }

  async scrapeLoop() {
    let pageTransactions = await this.scrapeThisPage();

    // if lastDate reached return false
    if (new Date(pageTransactions[pageTransactions.length - 1].date) <= this.lastDate) {
      console.log("Gone far enough back");
      // this.stopScrapeing("gone far enough");
      return pageTransactions;
    } else {
      // click previous page button
      console.log("Loading previous transaction page");

      await this.page.evaluate(async function clickPrevious() {
        function sleep(ms) {
          return new Promise(resolve => setTimeout(resolve, ms));
        }

        let startBalance = document.querySelector('table[class="table table-std"] tbody tr:last-child').childNodes[5].innerText;
        let newBlanace = startBalance;
        // document.querySelector('a[action="previous"]').click();
        angular.element(document.querySelector('a[action="previous"]')).triggerHandler('click');
        do{
          await sleep(100);
          newBlanace = document.querySelector('table[class="table table-std"] tbody tr:last-child').childNodes[5].innerText;
        } while (newBlanace == startBalance);
      });
      // await u.wait('#statementTable table tbody tr:nth-child(1) td:nth-child(6)')
      return pageTransactions.concat(await this.scrapeLoop());
    }
  }

  async scrapeThisPage() {
    console.log("Scraping this page for transactions");
    // move into the page for the next bit
    let pageTransactions = [];
    let res = await this.page.evaluate(function parseStatement() {
      var txnList = []; // transaction list for this page

      // parse all records out from this page into object
      var rows = document.querySelectorAll('table[class="table table-std"] tbody tr');
      // make sure we got something
      if (rows.length) {
        // for each row in table
        [].forEach.call(rows, function (row) {
          var txd; // blank to hold transaction data for this row
          txd = {}; // make it a dict
          txnList.push(txd); // push on page list
          // grab:-
          // date (convert form 23 Feb 15 to 23/02/15 UK)
          txd['date'] = new Date(row.childNodes[0].innerText).toString();
          // recombine description
          txd['description'] = row.childNodes[1].innerText.toUpperCase().replace(',', '').trim();
          // type
          txd['type'] = row.childNodes[2].innerText.trim();
          // in amount
          txd['in'] = row.childNodes[3].innerText.trim();
          // out amount
          txd['out'] = row.childNodes[4].innerText.trim();
          // balance
          txd['balance'] = row.childNodes[5].innerText.trim();
        });
      }
      // console.log(txnList)
      return txnList;
    });
    // Back out the page now
    // join the transaction form this page onto the rest
    pageTransactions = pageTransactions.concat(res);
    // // require('utils').dump(res);
    // require('utils').dump(this.allTransactions);
    this.pageCount += 1;
    console.log('Current page: ' + this.pageCount);
    // console.log('Current transaction count: ' + pageTransactions.length);
    return pageTransactions;
  }

  toString() {
    return '[Account ' + this.number + ']';
  }
};
