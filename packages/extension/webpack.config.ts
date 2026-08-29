import path from 'path';
import { fileURLToPath } from 'url';
import { merge } from 'webpack-merge';
import CopyWebpackPlugin from 'copy-webpack-plugin';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import type { Configuration } from 'webpack';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const commonConfig: Configuration = {
  resolve: {
    extensions: ['.ts', '.js'],
    extensionAlias: {
      '.js': ['.ts', '.js'],
    },
    alias: {
      '@shared': path.resolve(__dirname, '../shared/src'),
    },
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        loader: 'esbuild-loader',
        options: {
          target: 'es2022',
        },
        exclude: /node_modules/,
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  devtool: 'source-map',
};

const config: Configuration = merge(commonConfig, {
  entry: {
    'service-worker': './src/background/service-worker.ts',
    'content-script': './src/content/content-script.ts',
    popup: './src/ui/popup/popup.ts',
    options: './src/ui/options/options.ts',
    'runtime-panel': './src/ui/runtime-panel/runtime-panel.ts',
  },
  output: {
    path: path.resolve(__dirname, 'build'),
    filename: '[name].js',
    clean: true,
  },
  optimization: {
    splitChunks: false,
  },
  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        { from: 'src/manifest.json', to: 'manifest.json' },
        { from: 'src/managed-storage-schema.json', to: 'managed-storage-schema.json' },
        { from: 'static/icons', to: 'icons' },
      ],
    }),
    new HtmlWebpackPlugin({
      template: 'src/ui/popup/popup.html',
      filename: 'popup.html',
      chunks: ['popup'],
    }),
    new HtmlWebpackPlugin({
      template: 'src/ui/options/options.html',
      filename: 'options.html',
      chunks: ['options'],
    }),
    new HtmlWebpackPlugin({
      template: 'src/ui/runtime-panel/runtime-panel.html',
      filename: 'runtime-panel.html',
      chunks: ['runtime-panel'],
    }),
  ],
});

export default config;
