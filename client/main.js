/* global grist */

let invoiceRow = null;
let syncBtn = document.getElementById("sync");

function readDoc(msg) {
 console.log("readDoc", msg);
 const rowId = msg.rowId;
 if (!rowId) {
   console.log("sync: no rowId");
   return;
 }
 syncBtn.disabled = true;
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
   syncBtn.disabled = false;
 });
}

function onClickSync(ev) {
 console.log("using invoiceRow", invoiceRow);
 return fetch(`/sync/${invoiceRow.Invoice_ID}`, {method: 'POST'})
 .then((result) => result.json())
 .then((resultJson) => {
   console.log("result", resultJson);
 });
}

grist.on('message', readDoc);
syncBtn.addEventListener('click', onClickSync);
grist.ready();
