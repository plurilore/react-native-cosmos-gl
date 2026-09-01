const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const root = path.resolve(__dirname, '..')
const config = getDefaultConfig(__dirname)

// Metro does not follow symlinks or `file:` links out of the project by
// default, so the library source has to be an explicit watch root and its
// dependencies resolved from this app's node_modules. Without both, editing a
// file in `src/` does not trigger a reload and React resolves twice.
config.watchFolders = [root]
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  path.resolve(root, 'node_modules'),
]
config.resolver.extraNodeModules = {
  'react-native-cosmos-gl': path.resolve(root, 'src'),
}
// React and React Native must resolve to exactly one copy; two would give the
// classic "invalid hook call" with no useful stack.
for (const name of ['react', 'react-native', 'react-native-gesture-handler', 'expo-gl']) {
  config.resolver.extraNodeModules[name] = path.resolve(__dirname, 'node_modules', name)
}

module.exports = config
