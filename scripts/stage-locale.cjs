'use strict';

const fs = require('node:fs');
const path = require('node:path');

function stageChineseUi(appDirectory) {
  const map = JSON.parse(fs.readFileSync(path.join(appDirectory, 'locale-zh-CN.json'), 'utf8'));
  const target = path.join(appDirectory, 'public-zh-CN');
  fs.mkdirSync(target, { recursive: true });
  for (const [file, translations] of Object.entries(map)) {
    const source = fs.readFileSync(path.join(appDirectory, 'public', file), 'utf8');
    const pattern = file.endsWith('.html')
      ? /(?<=aria-label=")[^"]+|(?<=title=")[^"]+|(?<=alt=")[^"]+|(?<=placeholder=")[^"]+|(?<=>)[^<>]+(?=<)/g
      : /(['"])(?:\\.|(?!\1)[^\\\r\n])*\1/g;
    const translated = source.replace(pattern, text => Object.hasOwn(translations, text) ? translations[text] : text);
    const result = file.endsWith('.html') ? translated.replace('<html lang="en">', '<html lang="zh-CN">') : translated;
    fs.writeFileSync(path.join(target, file), result);
  }
}

module.exports = { stageChineseUi };
