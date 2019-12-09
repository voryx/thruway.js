'use strict';
let webpack = require('webpack');

module.exports = {
    entry: './index.ts',
    externals: [{'ws': 'WebSocket'}],
    output: {
        library: 'thruway',
        filename: './thruway.js'
    },
    resolve: {
        extensions: ['.webpack.js', '.web.js', '.ts', '.js']
    },
    module: {
        rules: [
            { test: /\.tsx?$/, loader: "ts-loader" }
        ]
    },
    optimization: {
        minimize: true
    },
    plugins: [
        new webpack.LoaderOptionsPlugin({
            minimize: true,
            debug: false
        })
    ]
};
