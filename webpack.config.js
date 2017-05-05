'use strict';
let webpack = require('webpack');

module.exports = {
    entry: './index.ts',
    externals: [{'ws': 'WebSocket'}],
    output: {
        library: 'thruway',
        filename: './dist/thruway.js'
    },
    resolve: {
        extensions: ['.webpack.js', '.web.js', '.ts', '.js']
    },
    module: {
        loaders: [
            {
                test: /\.ts$/,
                loader: "ts-loader"
            }
        ]
    },
    plugins: [
        new webpack.LoaderOptionsPlugin({
            minimize: true,
            debug: false
        }),
        new webpack.optimize.UglifyJsPlugin({
            compress: {
                warnings: true
            },
            output: {
                comments: false
            },
            sourceMap: false
        })
    ]
};
