const path = require('path');
// path to module root
const root = path.resolve(__dirname);
const CopyPlugin = require('copy-webpack-plugin')

module.exports = {
  mode: process.env.PRODUCTION ? 'production' : 'development',
  entry: './index.js',
  output: {
    libraryTarget: 'commonjs2',
    filename: 'index.js',
    path: path.resolve(__dirname, 'dist'),
    devtoolModuleFilenameTemplate: (info) => {
      const relativePath = path.relative(root, info.absoluteResourcePath)
      return `webpack://${relativePath}`;
    }
  },
  externals: [
    {
      'aws-sdk': true,
      'electron': true,
      'formidable': 'url'
      // '../build/Release/canvas.node': true
    },
    function(context, request, callback) {
      if (/^..\/build\/Release\/canvas.node$/.test(request)){
        console.log(request);
        const test = './build/Release/canvas.node';
        return callback(null, 'commonjs ' + test);
      }
      callback();
    }
  ],
  resolve: {
    alias: {
      '../build/Release/canvas.node': './build/Release/canvas.node'
    }
  },
  plugins: [
    new CopyPlugin([{
      from: 'node_modules/@cumulus/ingest/node_modules/canvas/build/Release/canvas.node',
      to: 'build/Release'
    }])
  ],
  module: {
    rules: [
      {
        test: /\.js$/,
        // exclude: /node_modules/,
        exclude: /node_modules\/(?!(jsdom)\/).*/,
        use: [
          {
            loader: 'babel-loader',
            options: {
              cacheDirectory: true,
              presets: [
                ["@babel/preset-env", {
                  modules: "commonjs",
                  targets: {
                    node: "10"
                  }
                }]
              ],
              plugins: [
                "@babel/plugin-proposal-optional-catch-binding"
              ]
            }
          }
        ]
      },
      {
        test: /\.node$/,
        use: 'node-loader'
      }
    ],
  },
  devtool: 'inline-source-map',
  target: 'node'
};
