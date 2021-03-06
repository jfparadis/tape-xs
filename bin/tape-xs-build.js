/** tape-xs-build: build tape style test driver for xs
 */

import detective from 'detective-es6';

const USAGE = 'Usage: tape-xs-build /full/path/to/a-package/ test/*.js';

const REPLACEMENTS = {
  '@agoric/harden':      'src/harden-xs',

  // npm
  'tape-promise/tape':   'src/tape',
};

const MANIFEST_DEFAULTS = {
  include: "$(MODDABLE)/examples/manifest_base.json",

  // "machine" size: somewhat arbitrary but larger than
  // microcontroller-oriented default
  creation: {
    keys: {
      available: 4096,
    },
    stack: 4096
  },

  // Don't try to strip out unused components.
  // Dynamically loaded code might want more.
  strip: [],

  // Share theHarness between tests and driver.
  preload: ['tape-promise/tape'],
};


async function main(argv, { fsp, cabinet, assets }) {
  const [directory, ...filenames] = argv.slice(2);
  const pkg = directory.replace(/\/$/, '').split('/').slice(-1)[0];

  if (!directory || !pkg || filenames.length < 1) { throw USAGE; }

  let allDeps = [];
  const testMods = [];

  for (const filename of filenames) {
    const deps = await moduleDeps(filename, {
      getSource: async fn => await fsp.readFile(fn, 'utf-8'),
      findModule: (specifier, fn) =>
	specifier in REPLACEMENTS ? `${assets}/${REPLACEMENTS[specifier]}.js` :
	cabinet({
	  partial: specifier, directory: directory, filename: fn,
	  nodeModulesConfig: { entry: 'module' },
	}),
      filter: dep => dep.specifier !== 'module',
    });
    testMods.push(deps[0].specifier);
    // console.log({ filename, deps });
    allDeps = [...allDeps, ...deps];
  }

  const result = { package: pkg, manifest: `test-xs-manifest.json`, main: `test-xs-main.js` };

  const manifest = moduleManifest(result.main, allDeps, directory, assets);
  const manifestJSON = JSON.stringify(manifest, null, 2);
  await fsp.writeFile(result.manifest, manifestJSON);

  const main_tpl = await fsp.readFile(`${assets}/tpl/main_tpl.js`, 'utf-8');
  const main = main_tpl
	.replace('__PACKAGE__', JSON.stringify(pkg))
	.replace('__TESTMODS__', JSON.stringify(testMods));
  await fsp.writeFile(result.main, main);

  console.log(result);
  console.log(`try: mcconfig -d -m ${result.manifest}`);
}


async function moduleDeps(filename, { getSource, findModule, filter }) {
  let queue = [{ filename }];
  const seen = new Set();
  let out = [{ specifier: filename.replace(/\.js$/, ''), filename }];

  while (queue.length > 0) {
    const { filename: fn } = queue.pop();
    const src = await getSource(fn);
    const deps = detective(src)
	  .map(specifier => ({ specifier, filename: findModule(specifier, fn) }));
    const newDeps = deps.filter(dep => filter(dep) && !seen.has(dep.filename));
    out = [...out, ...newDeps];
    queue = [...queue, ...newDeps];
  }
  return out;
}


function moduleManifest(main, deps, topDir, assets) {
  // xs doesn't want .js on the end of source filenames
  const stripExt = fn => fn.replace(/.js$/, '');

  function relative(fullPath) {
    return './' + fullPath.slice(topDir.length);
  }

  function modKey(specifier, fullPath) {
    if (typeof specifier === 'string' && !/^\.\.?\//.exec(specifier)) {
      // bare
      return specifier;
    } else if (fullPath.startsWith(topDir)) {
      // local
      return stripExt(relative(fullPath));
    } else if (fullPath.indexOf('node_modules/@agoric') >= 0) {
      // @agoric/eventual-send/src/E -> @agoric/E
      const [_, f] = /node_modules\/@agoric\/[^\/]+\/src\/(.*)/.exec(fullPath);
      return `@agoric/${f.replace(/\.js$/, '')}`;
    } else {
      return specifier;
    }
  }

  const modules = Object.fromEntries(deps.map(
    ({ specifier, filename }) => [modKey(specifier, filename), stripExt(filename)]
  ));

  return {
    ...MANIFEST_DEFAULTS,
    modules: {
      main: `./${main.replace(/\.js$/, '')}`,
      'xs-platform/console': `${assets}/src/console`,
      ...modules,
    },
  };
}


/* global require, module, process, __dirname */
if (require.main === module) {
  // Access process authority only when invoked as script.
  main(process.argv, {
    fsp: require('fs').promises,
    cabinet: require('filing-cabinet'),
    assets: __dirname.replace(/\/bin$/, ''),
  })
    .catch(oops => { console.error(oops); });
}
