/**
 * In development, run:
 *
 *    env GRIST_API_KEY=<YOUR-KEY> npm start
 *
 * For production, build and run like so:
 *
 *    bin/webpack
 *    env GRIST_API_KEY=<YOUR-KEY> node server/server.js
 *
 * To expose to outside world (e.g. a phone) while developing, adding devServer.host = '0.0.0.0'
 * (or HOST=0.0.0.0 in production) should be enough but does not ask to open the firewall on my
 * mac. This forwarding, however, works for me:
 *
 *    socat -d -d tcp-listen:9300,reuseaddr,fork tcp:localhost:9200
 *
 * Then visit http://<EXT-IP-ADDR>:9300
 */
const http = require('http');
const express = require('express');
const morgan = require('morgan');
const {GristDocAPI} = require('grist-api');
const pick = require('lodash/pick');
const util = require('util');
const debuglog = util.debuglog('app');

// TODO For production, try this:
// const GRIST_SERVER = 'https://docs.getgrist.com';
const GRIST_SERVER = 'http://localhost:8080';
const SOURCE_DOC_ID = 'wW5ATuoLAKwH95zj7b8vkf';

if (!process.env.GRIST_API_KEY) {
  console.warn('Specify env GRIST_API_KEY=<key> when running server');
  process.exit(1);
}
const GRIST_API_KEY = process.env.GRIST_API_KEY;

async function main() {
  const app = express();
  const port = parseInt(process.env.PORT, 10) || 7777;
  const host = process.env.HOST || "localhost";

  app.set('port', port);
  const server = http.createServer(app)
  initialize(app, server);

  // Serve the static page and the build client-side code.
  app.use('/', express.static('./public'));
  app.use('/build', express.static('./build'));

  await new Promise((resolve, reject) => server.listen(port, host, resolve).on('error', reject));
  console.log(`Server available at http://${host}:${port}`);
}

// When running via webpack-dev-server, it handles static files and runs initialize() directly.
async function initialize(app, server) {
  app.use(morgan(':date[iso] :method :url :status :response-time ms - :res[content-length]'));
  app.post('/sync/:invoiceId', express.json(), onSync);
}
exports.initialize = initialize;

// Handle the request to sync an invoice. The request only includes an `invoiceId` parameter.
// We use the hard-coded SOURCE_DOC_ID to look up the invoice. It should include InvoicerDocId
// with the document to sync it to.
async function onSync(req, res, next) {
  try {
    const invoiceId = parseInt(req.params.invoiceId, 10);
    if (!invoiceId) { throw new Error("Invalid or missing invoiceId"); }

    // Find the invoice in the source document.
    const gristApiSrc = new GristDocAPI(SOURCE_DOC_ID, {apiKey: GRIST_API_KEY, server: GRIST_SERVER});
    const sourceInvoice = (await gristApiSrc.fetchTable('Invoices', {Invoice_ID: [invoiceId]}))[0];
    if (!sourceInvoice) { throw new Error(`Invoice ${invoiceId} not found`); }
    debuglog("sourceInvoice", sourceInvoice);

    // Get the items connected to this invoice.
    const sourceItems = await gristApiSrc.fetchTable("Items", {Invoice: [sourceInvoice.id]});
    debuglog("sourceItems", sourceItems);

    // Get the destination document to sync to.
    const destDocId = sourceInvoice.InvoicerDocId;
    if (!destDocId || typeof destDocId != 'string') { throw new Error("DestDocId missing or invalid"); }
    const gristApiDest = new GristDocAPI(destDocId, {apiKey: GRIST_API_KEY, server: GRIST_SERVER});

    // Sync the invoice itself first: it will get added or updated.
    const invoiceCopy = pick(sourceInvoice, ['Invoice_ID', 'Date', 'CustomerJson']);
    await gristApiDest.syncTable('Invoices', [invoiceCopy], ['Invoice_ID']);

    // We need to look it up to get the id of the new record.
    const destInvoice = (await gristApiDest.fetchTable('Invoices', {Invoice_ID: [invoiceId]}))[0];
    if (!destInvoice) { throw new Error(`Invoice ${invoiceId} failed to sync`); }
    debuglog("destInvoice", destInvoice);

    // Sync the invoice items, each tied to the newly-added record.
    const itemsCopy = sourceItems.map(si => ({
      ...pick(si, ['Description', 'Unit_Price', 'Quantity']),
      Invoice: destInvoice.id
    }));
    await gristApiDest.syncTable("Items", itemsCopy, ["Invoice", "Description"], {Invoice: [destInvoice.id]});

    // Delete gone items, because syncTable doesn't do it for us.
    const destItems = await gristApiDest.fetchTable("Items", {Invoice: [destInvoice.id]});
    const destItemsToDelete = destItems.filter((i) => !itemsCopy.some(c => c.Description === i.Description));
    await gristApiDest.deleteRecords("Items", destItemsToDelete.map(i => i.id));

    // Respond to the client request.
    res.send({id: destInvoice.id});
  } catch (err) {
    console.warn(`Sync failed with ${err}`);
    next(err);
  }
}

if (require.main === module) {
  main().catch((err) => console.log("ERROR", err));
}

