/*
 * speedy-vision.js
 * GPU-accelerated Computer Vision for the web
 * Copyright 2020 Alexandre Martins <alemartf(at)gmail.com>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * brisk.js
 * BRISK feature detector & descriptor
 */

import { FeaturesAlgorithm } from '../features-algorithm';
import { IllegalArgumentError, NotImplementedError } from '../../../utils/errors';
import { SpeedyGPU } from '../../../gpu/speedy-gpu';
import { PYRAMID_MAX_LEVELS } from '../../../utils/globals';

// constants
const DESCRIPTOR_SIZE = 64; // 512 bits
const DEFAULT_DEPTH = 4; // will check 4 pyramid layers (7 octaves)
const MIN_DEPTH = 1; // minimum depth level
const MAX_DEPTH = PYRAMID_MAX_LEVELS; // maximum depth level

// static data
let shortPairs = null, longPairs = null;


/**
 * BRISK feature detector & descriptor
 */
export class BRISKFeatures extends FeaturesAlgorithm
{
    /**
     * Class constructor
     * @param {SpeedyGPU} gpu 
     */
    constructor(gpu)
    {
        super(gpu);

        // default settings
        this._depth = DEFAULT_DEPTH;
    }

    /**
     * Descriptor size for BRISK
     * @returns {number} in bytes
     */
    get descriptorSize()
    {
        return DESCRIPTOR_SIZE;
    }

    /**
     * Get the depth of the algorithm: how many pyramid layers will be scanned
     * @returns {number}
     */
    get depth()
    {
        return this._depth;
    }

    /**
     * Set the depth of the algorithm: how many pyramid layers will be scanned
     * @param {number} depth
     */
    set depth(depth)
    {
        if(depth < MIN_DEPTH || depth > MAX_DEPTH)
            throw new IllegalArgumentError(`Invalid depth: ${depth}`);

        this._depth = depth | 0;
    }

    /**
     * Detect BRISK features
     * @param {WebGLTexture} inputTexture pre-processed greyscale image
     * @returns {WebGLTexture} encoded keypoints
     */
    detect(inputTexture)
    {
        // TODO
        throw new NotImplementedError();
    }

    /**
     * Compute BRISK descriptors
     * @param {WebGLTexture} inputTexture pre-processed greyscale image
     * @param {WebGLTexture} encodedKeypoints encoded, oriented and multi-scale
     * @returns {WebGLTexture} encoded keypoints with descriptors
     */
    describe(inputTexture, encodedKeypoints)
    {
        // TODO
        return encodedKeypoints;
    }

    /**
     * Short distance pairings, for scale = 1.0. Format:
     * [x1,y1,x2,y2, ...]. Thus, 4 elements for each pair
     * @returns {Float32Array<number>} flattened array
     */
    static get shortDistancePairs()
    {
        return shortPairs || (shortPairs = briskShortDistancePairs());
    };

    /**
     * Long distance pairings, for scale = 1.0. Format:
     * [x1,y1,x2,y2, ...]. Thus, 4 elements for each pair
     * @returns {Float32Array<number>} flattened array
     */
    static get longDistancePairs()
    {
        return longPairs || (longPairs = briskLongDistancePairs());
    }
}

/**
 * (Modified) BRISK pattern for 60 points:
 * 5 layers with k_l colliding circles,
 * each at a distance l_l from the origin
 * with radius r_l. For each layer l=0..4,
 * we have k_l = [1,10,14,15,20] circles
 *
 * @param {number} [scale] pattern scale
 *                 (e.g, 1, 0.5, 0.25...)
 * @returns {Array<object>}
 */
function briskPattern(scale = 1.0)
{
    const piOverTwo = Math.PI / 2.0;
    const baseDistance = 4.21; // innermost layer for scale = 1

    const s10 = Math.sin(piOverTwo / 10);
    const s14 = Math.sin(piOverTwo / 14);
    const s15 = Math.sin(piOverTwo / 15);
    const s20 = Math.sin(piOverTwo / 20);

    const l10 = baseDistance * scale;
    const r10 = 2 * l10 * s10;

    const r14 = (2 * (l10 + r10) * s14) / (1 - 2 * s14);
    const l14 = l10 + r10 + r14;

    const r15 = (2 * (l14 + r14) * s15) / (1 - 2 * s15);
    const l15 = l14 + r14 + r15;

    const r20 = (2 * (l15 + r15) * s20) / (1 - 2 * s20);
    const l20 = l15 + r15 + r20;

    const r1 = r10 * 0.8; // guess & plot!
    const l1 = 0.0;

    return [
        { n: 1, r: r1, l: l1 },
        { n: 10, r: r10, l: l10 },
        { n: 14, r: r14, l: l14 },
        { n: 15, r: r15, l: l15 },
        { n: 20, r: r20, l: l20 },
    ];
}

/**
 * BRISK points given a
 * {n, r, l} BRISK layer
 * @param {object} layer
 * @returns {Array<object>}
 */
function briskPoints(layer)
{
    const { n, r, l } = layer;
    const twoPi = 2.0 * Math.PI;

    return [...Array(n).keys()].map(j => ({
        x: l * Math.cos(twoPi * j / n),
        y: l * Math.sin(twoPi * j / n),
        r, l, j, n,
    }));
}

/**
 * BRISK pair of points such that
 * the distance of each is greater
 * than (threshold*scale), or less
 * than (-threshold*scale) if
 * threshold < 0
 * @param {number} threshold
 * @param {number} [scale] pattern scale
 * @returns {Float32Array<number>} format [x1,y1,x2,y2, ...]
 */
function briskPairs(threshold, scale = 1.0)
{
    const flatten = arr => arr.reduce((v, e) => v.concat(e), []);
    const p = flatten(briskPattern(scale).map(briskPoints));
    const n = p.length, t = +threshold * scale;

    const dist2 = (p, q) => (p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y);
    const wanted = (t < 0) ? ((p,q) => dist2(p,q) < t*t) : ((p,q) => dist2(p,q) > t*t);
    const pairs = [];

    for(let i = 1; i < n; i++) {
        for(let j = 0; j < i; j++) {
            if(wanted(p[i], p[j])) {
                pairs.push(p[i].x);
                pairs.push(p[i].y);
                pairs.push(p[j].x);
                pairs.push(p[j].y);
            }
        }
    }

    return new Float32Array(pairs);
}

/**
 * BRISK short distance pairs
 * @param {number} threshold pick pairs with distance < threshold*scale
 * @param {number} [scale] pattern scale
 * @returns {Float32Array<number>} format [x1,y1,x2,y2, ...]
 */
function briskShortDistancePairs(threshold = 9.75, scale = 1.0)
{
    return briskPairs(-threshold, scale);
}

/**
 * BRISK long distance pairs
 * @param {number} threshold pick pairs with distance > threshold*scale
 * @param {number} [scale] pattern scale
 * @returns {Float32Array<number>} format [x1,y1,x2,y2, ...]
 */
function briskLongDistancePairs(threshold = 13.67, scale = 1.0)
{
    return briskPairs(threshold, scale);
}