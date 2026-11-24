import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('worker-assets/vendor',{recursive:true});
for(const file of ['catalog-import.js','manifest.webmanifest','admin-accounts.js','operations-domain.js','operations.js','index.html','app.js','domain.js','style.css','work-requests.js','worker-pages.js','auth-diagnostics.js','navigation.js','drafts.js','attendance-reports.js','test-data-reset.js','attendance-report.js','attendance-view.js'])await copyFile(`public/${file}`,`worker-assets/${file}`);
await mkdir('worker-assets/icons',{recursive:true});
for(const file of ['onwork-192.png','onwork-512.png','onwork-maskable-512.png','apple-touch-icon.png'])await copyFile(`public/icons/${file}`,`worker-assets/icons/${file}`);
await copyFile('node_modules/@zxing/browser/umd/zxing-browser.min.js','worker-assets/vendor/zxing.js');
await copyFile('node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js','worker-assets/vendor/passkeys.js');
await copyFile('public/passkeys.js','worker-assets/passkeys.js');
console.log('Workers 정적 파일 준비 완료');
