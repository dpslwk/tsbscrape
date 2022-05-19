#!/usr/bin/env node
const util = require('util');
const path = require('path');
const fs = require('fs');
const fs_writeFile = util.promisify(fs.writeFile);
require('log-timestamp');

const program = require('commander');
const Configstore = require('configstore');
const prompt = require('syncprompt');
const axios = require('axios');
const oauth = require('axios-oauth-client');
const tokenProvider = require('axios-token-interceptor');
let {PythonShell} = require('python-shell')


const pkg = require('./package.json');
const session = require('./session.js');

const conf = new Configstore(pkg.name);

program
  .version(pkg.version)
  .description('Programmatic access to TSB online banking.')
  .option('--no-headless', 'Show browser window when interacting');

program
  .command('list')
  .description('List all available accounts')
  .action(async options => {
    console.log('list');
    var sess;
    try {
      sess = await auth();
    } catch (err) {
      console.error(err);
      return;
    }

    try {
      const accounts = await sess.accounts();
      console.log(accounts.map(acc => acc.number));
    } catch (err) {
      console.error(err);
    } finally {
      await sess.close();
    }
  });

program
  .command('hms2_upload')
  .description('Fetch latest transactions and upload to hms2')
  .option('-b, --bypassssl', 'Bypass ssl checks.')
  .option('-g, --gnucash', 'Also import records into GnuCash')
  .action(async (options) => {
    console.log('hms2_upload');
    if (options.bypassssl) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }

    if (!(conf.has('hms2clientId') && conf.has('hms2clientSecret') && conf.has('hms2url'))) {
      console.error(
        'TSBscrape has not been configured for HMS 2 upload. Please run `tsbscrape config_hms2`',
      );
      program.help();
    }

    // setup oauth and axios
    const getOwnerCredentials = oauth.client(axios.create(), {
      url: conf.get('hms2url') + 'oauth/token',
      grant_type: 'client_credentials',
      client_id: conf.get('hms2clientId'),
      client_secret: conf.get('hms2clientSecret'),
    });

    const instance = axios.create();
    instance.interceptors.request.use(
      // Wraps axios-token-interceptor with oauth-specific configuration,
      // fetches the token using the desired claim method, and caches
      // until the token expires
      oauth.interceptor(tokenProvider, getOwnerCredentials)
    );
    instance.defaults.headers.common['Accept'] = 'application/json';

    var sess;
    try {
      sess = await auth();
    } catch (err) {
      console.error(err);
      return;
    }

    try {
      const accounts = await sess.accounts();
      for (let account of accounts) {
        const transactions = await account.statementCSV(conf);
        if (transactions) {
          // console.log(transactions[0]);
          /*
           * example JSON for request
           * [
           *     {
           *         "sortCode" : "77-22-24",
           *         "accountNumber" : "13007568",
           *         "date" : "2017-07-17",
           *         "description" : "Edward Murphy HSNTSBBPRK86CWPV 4",
           *         "amount" : 500
           *     },
           *     {
           *         "sortCode" : "77-22-24",
           *         "accountNumber" : "13007568",
           *         "date" : "2017-07-16",
           *         "description" : "Gordon Johnson HSNTSB27496WPB2M 53",
           *         "amount" : 700
           *     },
           *     {
           *         "sortCode" : "77-22-24",
           *         "accountNumber" : "13007568",
           *         "date" : "2017-07-16",
           *         "description" : "BIZSPACE",
           *         "amount" : -238963
           *     }
           * ]
           */
          let mappedTransactions = transactions.map(function (t) {
            let txnDate = new Date(t['date'] + ' UTC');
            var amount;
            if (t['in']) {
              amount = parseInt(t['in'].replace(/[£,.]/g, ''));
            } else {
              amount = -parseInt(t['out'].replace(/[£,.]/g, ''));
            }

            let transaction = {
              "sortCode" : account.sortCode,
              "accountNumber" : account.number,
              "date" : txnDate.toJSON(),
              "description" : t['description'],
              "amount" : amount
            };

            return transaction;
          });
          // console.log(mappedTransactions[0]);

          // transactions haver been mapped, now to pass onto hms2
          console.log('Transactions mapped');
          // console.log(mappedTransactions);

          console.log('Uploading to HMS 2');
          instance.post(conf.get('hms2url') + 'api/cc/bank-transactions/upload', mappedTransactions)
          .then(function (response) {
            console.log('Transactions Uploaded');
            // console.log(response);
          })
          .catch(function (error) {
            console.log(error);
          });

          // import to gnucash
          if (options.gnucash) {
            await gunCashImport(transactions);
          }
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      await sess.close();
    }
  });

program
  .command('get_csv <out_path>')
  .description('Fetch .csv files for all accounts into out_path')
  .option('-m, --match', 'Include Transfer Account matches in csv output.')
  .action(async (out_path, options) => {
    console.log('get_csv');
    var sess;
    try {
      sess = await auth();
    } catch (err) {
      console.error(err);
      return;
    }

    try {
      const accounts = await sess.accounts();
      for (let account of accounts) {
        const transactions = await account.statementCSV(conf);
        if (transactions) {
          // console.log(transactions[0]);
          let d = new Date();
          let fileDate = d.getFullYear().toString() + zeroPad(d.getMonth()+1, 2) + zeroPad(d.getDate(), 2) + '_' + zeroPad(d.getHours(), 2) + zeroPad(d.getMinutes(), 2);
          let filename = 'tsb_' + account.number + '_' + fileDate + '.csv';

          // map transactions to csv
          var csvLines = transactions.map(function (d) {
              let txnDate = new Date(d['date']);
              let dateString = zeroPad(txnDate.getDate(), 2) + '/' + zeroPad(txnDate.getMonth()+1, 2)  + '/' + txnDate.getFullYear();
              var csvLine = dateString + ',' + d['type'] + ",'" + account.sortCode + ',' + account.number + ',' + d['description'] + ' ,' + d['out'].replace(/[£,]/g, '')+ ',' + d['in'].replace(/[£,]/g, '')+ ',' + d['balance'].replace(/[£,]/g, '');

              if (options.match) {
                let transferAccount = matchTransferAccount(d['description']);
                csvLine += ',' + transferAccount;
              }

              return csvLine;
          });

          // prepend headers
          // Transaction Date,Transaction Type,Sort Code,Account Number,Transaction Description,Debit Amount,Credit Amount,Balance,
          if (options.match) {
            csvLines.unshift("Transaction Date,Transaction Type,Sort Code,Account Number,Transaction Description,Debit Amount,Credit Amount,Balance,Transfer Account,");
          } else {
            csvLines.unshift("Transaction Date,Transaction Type,Sort Code,Account Number,Transaction Description,Debit Amount,Credit Amount,Balance,");
          }

          // write out object to csv file
          await fs_writeFile(path.join(out_path, filename), [].join.call(csvLines, '\n'));
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      await sess.close();
    }
  });

program
  .command('config')
  .description('Set up login details')
  .action(options => {
    var username = prompt('Enter your username: ');
    conf.set('username', username);
    var password = prompt('Enter your password: ');
    conf.set('password', password);
    var memInfo = prompt('Enter your memorable info: ');
    conf.set('memInfo', memInfo);
    var phoneType = prompt('Enter your phoneType to use for OTP SMS [home, mobile, work]: ');
    conf.set('phoneType', phoneType);
    conf.set('tracking', new Date());
    console.log('\nTSBscrape is now configured.');
  });

program
  .command('config_hms2')
  .description('Set up HMS 2 OAuth details')
  .action(options => {
    var hms2clientId = prompt('Enter HMS 2 client ID: ');
    conf.set('hms2clientId', hms2clientId);
    var hms2clientSecret = prompt('Enter HMS 2 client secrete: ');
    conf.set('hms2clientSecret', hms2clientSecret);
    var hms2url = prompt('Enter the HMS2 URL (inc http[s]://): ');
    if (hms2url.charAt(hms2url.length -1 ) != '/') {
      hms2url += '/';
    }
    conf.set('hms2url', hms2url);
    console.log('\nHMS2 is now configured.');
  });

program
  .command('config_gnucash')
  .description('Set up gnucash-imports')
  .action(options => {
    var gnuCashImport = prompt('Enter full path for tsb-import.py: ');
    conf.set('gnuCashImport', gnuCashImport);
    console.log('\ngnucash-imports is now configured.');
  });

program
  .command('config_mqtt')
  .description('Set up MQTT details')
  .action(options => {
    var mqttHost = prompt('Enter the host: ');
    conf.set('mqttHost', mqttHost);
    var mqttPort = prompt('Enter the port: ');
    conf.set('mqttPort', mqttPort);
    var mqttTopic = prompt('Enter the topic: ');
    conf.set('mqttTopic', mqttTopic);
    console.log('\nmqtt is now configured.');
  });

program.parse(process.argv);

async function auth() {
  if (!(conf.has('username') && conf.has('password') && conf.has('memInfo'))) {
    console.error(
      'TSBscrape has not been configured. Please run `tsbscrape config`',
    );
    program.help();
  }

  // The --no-sandbox argument is required here for this to run on certain kernels
  // and containerised setups. My understanding is that disabling sandboxing shouldn't
  // cause a security issue as we're only using one tab anyway.
  const sess = await session.launch({
    headless: program.headless,
    args: ['--no-sandbox'],
  });

  try {
    await sess.loginMemInfo({
      username: conf.get("username"),
      password: conf.get("password"),
      memInfo: conf.get("memInfo"),
      phoneType: conf.get("phoneType")
    },
    {
      host: conf.get('mqttHost'),
      port: conf.get('mqttPort'),
      topic: conf.get('mqttTopic')
    });
  } catch (err) {
    try {
      await sess.close();
    } catch (e) {}
    throw err;
  }
  return sess;
}

function zeroPad(num, places) {
  var zero = places - num.toString().length + 1;
  return Array(+(zero > 0 && zero)).join("0") + num;
}

function matchTransferAccount(description) {
  patterns = {
    'PLEDGE': 'Income:Pledge Payments',
    'HSNTSBLOAN': 'Liabilities:Membership Loan Payable',
    'HSNTSB': 'Income:Membership Payments',
    'TALKTALK': 'Expenses:Utilities:Internet',
    'SERVICE CHARGES': 'Expenses:Bank Service Charge',
    'PREMIUM CREDIT': 'Expenses:Insurance',
    'EASY CLEAN': 'Expenses:Cleaning',
    'GCCFM REFERENCE': 'Expenses:Cleaning',
    'GCC FACILITIES MA REFERENCE': 'Expenses:Cleaning',
    'TAURUS ACCOUNTING': 'Expenses:Professional Fees:Accounting',
    'REDWOOD LEGAL': 'Expenses:Professional Fees:Legal Fees',
    'CONFETTI NEW': 'Expenses:Teams:Trustees Misc',
    'BOC MANCHESTER': 'Expenses:BOC Gas',
    'NOTTM CITY COUNC': 'Expenses:Utilities:Business Rates',
    'PLANER INDUCTION': 'Income:Inductions:Planer Thicknesser',
    'BIZSPACE REFERENCE': 'Expenses:Bizspace Rent:F6',
    'BIZSPACE LIMITED REFERENCE': 'Expenses:Bizspace Rent:F6',
    'NOTTINGHAM CLIFTON': 'Assets:Current Assets:Petty Cash',
    '5\d{5}': 'Assets:Current Assets:Petty Cash',
    'HMRC - ACCOUNTS': 'Expenses:Member Loan Repayments:Tax on Interest',
    'DEPOSIT OF CASH': 'Assets:Current Assets:Petty Cash',
    'FAIR': 'Assets:Current Assets:FairFX',
    'WATER PLUS': 'Expenses:Utilities:Water',
    'EVENTBRITE INC': 'Income:Workshops:Eventbright',
    'SNACKSPACE': 'Income:Snackspace',
    'SNACK-EX': 'Income:Snackspace',
    'GREEN FESTIVAL': 'Expenses:Teams:Events',
    'VIRGIN MEDIA PYMT': 'Expenses:Utilities:Internet',
    'SUMUP PAYMENTS': 'Assets:Current Assets:SumUp',
    'STRIPE PAYMENTS': 'Assets:Current Assets:Stripe',
    'STRIPE STRIPE': 'Assets:Current Assets:Stripe',
    'TV LICENCE': 'Expenses:Teams:Trustees Misc',
    'ADYEN N.V. REFERENCE': 'Income:Donations:GoFundMe PPE',
    'HSNOTTSPPE': 'Expenses:Miscellaneous:GoFundMe PPE'
  };

  for (var pattern in patterns) {
    match = description.match(new RegExp(pattern));
    if (match !== null) {
      return patterns[pattern];
    }
  }

  return "Imbalance-GBP";
}

async function gunCashImport(transactions) {
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  console.log('Importing to GnuCash')

  if (!conf.has('gnuCashImport')) {
    console.error(
      'TSBscrape has not been configured for GnuCash import. Please run `tsbscrape config_gnucash`',
    );
    program.help();
  }

  let gnucashMappedTransactions = transactions.map(function (t) {
    let txnDate = new Date(t['date'] + ' UTC');
    var amount;
    if (t['in']) {
      amount = parseInt(t['in'].replace(/[£,.]/g, ''));
    } else {
      amount = -parseInt(t['out'].replace(/[£,.]/g, ''));
    }

    let transaction = {
      "date" : txnDate.toJSON(),
      "description" : t['description'],
      "in": parseInt(t['in'].replace(/[£,.]/g, '')),
      "out": parseInt(t['out'].replace(/[£,.]/g, '')),
      "amount": amount,
      "transferAccount": matchTransferAccount(t['description'])
    };

    return transaction;
  });
  // console.log(gnucashMappedTransactions);

  let options = {
    mode: 'json',
    pythonOptions: ['-u'] // get print results in real-time
  };

  let gnuCashImport = new PythonShell(conf.get('gnuCashImport'), options);

  gnuCashImport.on('message', function (message) {
    // received a message sent from the Python script (a simple "print" statement)
    console.log('[GnuCash Import] ' + message);
  });

  gnuCashImport.on('stderr', (stderr) => {
    console.error('[GnuCash Import] ' + stderr);
  });

  for (let transaction of gnucashMappedTransactions) {
    gnuCashImport.send(transaction);
  }

  gnuCashImport.end(function (err,code,signal) {
    if (err) throw err;
    console.log('[GnuCash Import] The exit code was: ' + code);
    console.log('[GnuCash Import] The exit signal was: ' + signal);
  });
}