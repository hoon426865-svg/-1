import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('worker-assets/vendor',{recursive:true});
for(const file of ['index.html','app.js','domain.js','style.css','work-requests.js','worker-pages.js'])await copyFile(`public/${file}`,`worker-assets/${file}`);
await copyFile('node_modules/@zxing/browser/umd/zxing-browser.min.js','worker-assets/vendor/zxing.js');
await copyFile('node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js','worker-assets/vendor/passkeys.js');
await copyFile('public/passkeys.js','worker-assets/passkeys.js');
console.log('Workers 정적 파일 준비 완료');
