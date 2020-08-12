/**
 * The webpack config, used by `npm start` and `npm run build`, which default to webpack.config.js
 * in the current directory.
 */
const path = require('path');

module.exports = {
  mode: "development",
  entry: {
    main: 'client/main.js',
  },
  output: {
    path: path.resolve(__dirname),
    filename: "build/[name].bundle.js",
    sourceMapFilename: "build/[name].bundle.js.map",
  },
  devtool: 'inline-source-map',
  resolve: {
    extensions: [".ts", ".tsx", ".js"],
    modules: [
      path.resolve('.'),
      path.resolve('./node_modules')
    ],
  },
  module: {
    rules: [
      { test: /\.tsx?$/, loader: "ts-loader", exclude: /node_modules/ }
    ]
  },
  devServer: {
    contentBase: path.resolve(path.join(__dirname, 'public')),
    port: process.env.PORT || 7777,
    open: false,

    before: (app, server) => {
      require('./server/index').initialize(app, server);
    },
  }
};
