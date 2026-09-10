'use strict';

// Пересборка подписи приложения на macOS.
//
// Electron приходит с подписью, которую линковщик Apple ставит на arm64-бинарь:
// ad-hoc, с идентификатором «Electron». electron-builder потом переименовывает
// приложение и подменяет ресурсы, а подпись остаётся прежней и перестаёт
// соответствовать содержимому. Проверка после этого падает с «code has no
// resources but signature indicates they must be present», и macOS показывает
// не «неизвестный разработчик», а «приложение повреждено» — с единственным
// предложением переместить его в корзину.
//
// Настоящего сертификата у проекта нет, но подписать заново ad-hoc можно и без
// него: подпись станет целостной и с нашим идентификатором. Приложение всё
// равно не заверено у Apple, поэтому при первом запуске система спросит
// разрешение, — но это обычный вопрос про неизвестного разработчика, а не
// тупик с корзиной.

const { execFileSync } = require('node:child_process');
const path = require('node:path');

module.exports = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  // Проверяем тут же: молча выпустить сборку со сломанной подписью — ровно та
  // ошибка, ради которой этот файл и появился.
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(`  • подпись пересобрана ad-hoc  ${app}`);
};
