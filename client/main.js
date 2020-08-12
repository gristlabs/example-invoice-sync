/* global grist, Vue */

let invoiceRow = null;
const data = {
  invoice: null,    // { id, docUrl, docName }
  copy: null,       // { lastCopyDate, invoiceDate, invoiceTotal }
  message: "Loading...",
};

function updateWidget(rowId) {
  let syncBtn = document.getElementById("sync");
  syncBtn.disabled = true;
  syncBtn.removeEventListener('click', onClickSync);
  grist.docApi.fetchSelectedTable().then(v => {
    const idx = v.id.indexOf(rowId);
    if (idx < 0) {
      console.log(`sync: rowId ${rowId} not found`);
      return;
    }
    const row = {};
    for (const key of Object.keys(v)) {
      row[key] = v[key][idx];
    }
    invoiceRow = row;
    const docId = row.InvoicerDocId;
    data.invoice = {
      id: invoiceRow.Invoice_ID,
      docUrl: docId ? getDocUrl(docId) : '',
      docName: docId || 'None',
    };
    data.copy = null;
    if (docId) {
      getCopyInfo();
      syncBtn.disabled = false;
      syncBtn.addEventListener('click', onClickSync);
    } else {
      data.message = null;
      syncBtn.disabled = true;
    }
  });
}

function getDocUrl(docId) {
  return new URL(`/doc/${docId}`, location.href).href;
}

function onClickSync(ev) {
 console.log("using invoiceRow", invoiceRow);
 return fetch(`/sync/${invoiceRow.Invoice_ID}`, {method: 'POST'})
 .then((result) => result.json())
 .then((resultJson) => {
   console.log("result", resultJson);
   return updateWidget(invoiceRow.id);
 });
}

async function getCopyInfo() {
  console.log("fetching using invoiceRow", invoiceRow);
  const resp = await fetch(`/invoice-copy-info/${invoiceRow.Invoice_ID}`);
  const value = await resp.json();
  if (resp.status === 200) {
    data.copy = {
      lastCopyDate: value.Last_Sync ? new Date(value.Last_Sync * 1000) : "-",
      invoiceDate: value.Date ? new Date(value.Date * 1000) : "-",
      invoiceTotal: value.Total,
    };
    data.message = null;
  } else {
    data.copy = null;
    data.message = value.error || "Can't fetch copied invoice";
  }
}

grist.on('message', (msg) => msg.rowId ? updateWidget(msg.rowId) : null);
grist.ready();

Vue.filter('currency', formatNumberAsUSD);
Vue.filter('datetime', val => val instanceof Date ? val.toISOString().slice(0, 19).replace('T', ' '): val);
Vue.filter('date', val => val instanceof Date ? val.toISOString().slice(0, 10) : val);
function formatNumberAsUSD(value) {
  if (!value) { return '—'; }
  return Number(value).toLocaleString('en', {
    style: 'currency', currency: 'USD'
  })
}

new Vue({
  el: '#app',
  data: data
});
