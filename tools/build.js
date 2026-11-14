// Bundle the app into one HTML file (data, CSS and JS inlined).
//   node tools/build.js            -> dist/rendezvous-campus.html  (open directly, no server needed)
//   node tools/build.js --artifact -> also dist/artifact.html      (body-only version for claude.ai artifacts)
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const outdoor = JSON.parse(read('data/outdoor.json'));
const indoor = JSON.parse(read('data/indoor_batC.json'));
const leafletCss = read('vendor/leaflet.css').replace(/^.*url\(.*$/gm, ''); // marker images are not used
const safe = s => s.replace(/<\/script/gi, '<\\/script');

let html = read('index.html')
  .replace(/<!--LEAFLET_CSS-->[\s\S]*?<!--\/LEAFLET_CSS-->/, '<style>' + leafletCss + '</style>')
  .replace(/<!--ML_CSS-->[\s\S]*?<!--\/ML_CSS-->/, () => '<style>' + read('vendor/maplibre-gl.css') + '</style>')
  .replace(/<!--APP_CSS-->[\s\S]*?<!--\/APP_CSS-->/, '<style>' + read('css/style.css') + '</style>')
  .replace(/<!--DATA-->[\s\S]*?<!--\/DATA-->/, () => '<script>window.CAMPUS_DATA=' + safe(JSON.stringify({ outdoor, indoor })) + ';</script>')
  .replace(/<!--APP_JS-->[\s\S]*?<!--\/APP_JS-->/, () => '<script>' + safe(fs.existsSync(path.join(root, 'js/config.js')) ? read('js/config.js') : read('js/config.example.js')) + '</script>\n<script>' + safe(read('js/sync.js')) + '</script>\n<script>' + safe(read('js/algorithms.js')) + '</script>\n<script>' + safe(read('js/app.js')) + '</script>');

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/rendezvous-campus.html'), html);
console.log('dist/rendezvous-campus.html', (html.length / 1024).toFixed(0) + ' KB');

if (process.argv.includes('--artifact')) {
  // claude.ai artifacts add their own <html>/<head>/<body>: keep title + styles at the top, then the body.
  const head = /<head>([\s\S]*?)<\/head>/.exec(html)[1]
    .replace(/<meta charset[^>]*>\s*/, '').replace(/<meta name="viewport"[^>]*>\s*/, '');
  const body = /<body>([\s\S]*?)<\/body>/.exec(html)[1];
  const art = '<meta name="claude:viewport-fit-sides" content="cover">\n' + head.trim() + '\n' + body.trim() + '\n';
  fs.writeFileSync(path.join(root, 'dist/artifact.html'), art);
  console.log('dist/artifact.html', (art.length / 1024).toFixed(0) + ' KB');
}
