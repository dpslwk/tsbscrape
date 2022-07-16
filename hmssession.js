const puppeteer = require('puppeteer');
const u = require('./utils.js');
const Account = require('./account.js');

class Session {
  async init(options, hmsUrl) {
    this.browser = await puppeteer.launch(options);
    this.page = await this.browser.newPage();
    this.logged_in = false;
    this.hmsUrl = hmsUrl
    //this.page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    await this.page.setViewport({width: 1000, height: 1500});
    await this.page.goto(this.hmsUrl+'/members/login');
  }

  async close() {
    this.browser.close();
  }

  async login(credentials) {
    // Stage 1 of login - enter surname and membership number.
    await u.wait(this.page, 'form#UserLoginForm');
    await u.fillFields(this.page, {
      '#UserUsernameOrEmail': credentials['username'],
      '#UserPassword': credentials['password'],
    });
    await u.click(this.page, '#UserLoginForm > div.submit > input[type="submit"]');
    await this.ensureLoggedIn();
    console.log("Login complete");
  }

  async ensureLoggedIn() {
    // Check that we're looking at the logged in homepage and throw an
    // error if we aren't.
    await u.wait(this.page, 'a#logout');
    this.logged_in = true;
  }

  async audit() {
    await this.page.goto(this.hmsUrl+'/auditMembers/audit');
    await u.wait(this.page, 'div#flashMessage');
    console.log("Audit complete");
  }

  async uploadCsv(filename) {
    await this.page.goto(this.hmsUrl+'/bankTransactions/uploadCsv');
    await u.wait(this.page, '#filename');
    const fileInput = await this.page.$('input[type=file]');
    await fileInput.uploadFile(filename);
    await u.click(this.page, '#uploadCsvForm > div.submit > input[type="submit"]');
    await u.wait(this.page, 'div#flashMessage');
    // TODO: check div#falshMessage has contents 'CSV upload complete'
    const result = await this.page.$eval('div#flashMessage', el => el.textContent);
    if (result != 'CSV upload complete') {
      const screenshotFile = './upload_error.png';
      await this.page.screenshot({path: screenshotFile});
      throw `File upload failed with message "${result}" on page ${this.page.url()}. Screenshot saved to ${screenshotFile}.`;
    }
    console.log('File uploaded');
  }
}

exports.launch = async (options, hmsUrl) => {
  const sess = new Session();
  await sess.init(options, hmsUrl);
  return sess;
};
