/**
* Copyright 2012-2018, Plotly, Inc.
* All rights reserved.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*/

'use strict';

var lineLayerMaker = require('./lines');
var c = require('./constants');
var Lib = require('../../lib');
var d3 = require('d3');
var Drawing = require('../../components/drawing');
var keyFun = require('../../lib/gup').keyFun;
var repeat = require('../../lib/gup').repeat;
var unwrap = require('../../lib/gup').unwrap;
var brush = require('./axisbrush');

function visible(dimension) {return !('visible' in dimension) || dimension.visible;}

function dimensionExtent(dimension) {

    var lo = dimension.range ? dimension.range[0] : Lib.aggNums(Math.min, null, dimension.values, dimension._length);
    var hi = dimension.range ? dimension.range[1] : Lib.aggNums(Math.max, null, dimension.values, dimension._length);

    if(isNaN(lo) || !isFinite(lo)) {
        lo = 0;
    }

    if(isNaN(hi) || !isFinite(hi)) {
        hi = 0;
    }

    // avoid a degenerate (zero-width) domain
    if(lo === hi) {
        if(lo === void(0)) {
            lo = 0;
            hi = 1;
        } else if(lo === 0) {
            // no use to multiplying zero, so add/subtract in this case
            lo -= 1;
            hi += 1;
        } else {
            // this keeps the range in the order of magnitude of the data
            lo *= 0.9;
            hi *= 1.1;
        }
    }

    return [lo, hi];
}

function toText(formatter, texts) {
    return function(v, i) {
        if(texts) {
            var text = texts[i];
            if(text === null || text === undefined) {
                return formatter(v);
            } else {
                return text;
            }
        } else {
            return formatter(v);
        }
    };
}

function domainScale(height, padding, dimension) {
    var extent = dimensionExtent(dimension);
    var texts = dimension.ticktext;
    return dimension.tickvals ?
        d3.scale.ordinal()
            .domain(dimension.tickvals.map(toText(d3.format(dimension.tickformat), texts)))
            .range(dimension.tickvals
                .map(function(d) {return (d - extent[0]) / (extent[1] - extent[0]);})
                .map(function(d) {return (height - padding + d * (padding - (height - padding)));})) :
        d3.scale.linear()
            .domain(extent)
            .range([height - padding, padding]);
}

function unitScale(height, padding) {return d3.scale.linear().range([height - padding, padding]);}
function unitScaleInOrder(height, padding) {return d3.scale.linear().range([padding, height - padding]);}
function domainToUnitScale(dimension) {return d3.scale.linear().domain(dimensionExtent(dimension));}

function ordinalScale(dimension) {
    var extent = dimensionExtent(dimension);
    return dimension.tickvals && d3.scale.ordinal()
            .domain(dimension.tickvals)
            .range(dimension.tickvals.map(function(d) {return (d - extent[0]) / (extent[1] - extent[0]);}));
}

function unitToColorScale(cscale) {

    var colorStops = cscale.map(function(d) {return d[0];});
    var colorStrings = cscale.map(function(d) {return d[1];});
    var colorTuples = colorStrings.map(function(c) {return d3.rgb(c);});
    var prop = function(n) {return function(o) {return o[n];};};

    // We can't use d3 color interpolation as we may have non-uniform color palette raster
    // (various color stop distances).
    var polylinearUnitScales = 'rgb'.split('').map(function(key) {
        return d3.scale.linear()
            .clamp(true)
            .domain(colorStops)
            .range(colorTuples.map(prop(key)));
    });

    return function(d) {
        return polylinearUnitScales.map(function(s) {
            return s(d);
        });
    };
}

function someFiltersActive(view) {
    return view.dimensions.some(function(p) {
        return brush.filterActive(p.brush);
    });
}

function model(layout, d, i) {
    var cd0 = unwrap(d),
        trace = cd0.trace,
        lineColor = cd0.lineColor,
        cscale = cd0.cscale,
        line = trace.line,
        domain = trace.domain,
        dimensions = trace.dimensions,
        width = layout.width,
        labelFont = trace.labelfont,
        tickFont = trace.tickfont,
        rangeFont = trace.rangefont;

    var lines = Lib.extendDeep({}, line, {
        color: lineColor.map(domainToUnitScale({
            values: lineColor,
            range: [line.cmin, line.cmax],
            _length: trace._commonLength
        })),
        blockLineCount: c.blockLineCount,
        canvasOverdrag: c.overdrag * c.canvasPixelRatio
    });

    var groupWidth = Math.floor(width * (domain.x[1] - domain.x[0]));
    var groupHeight = Math.floor(layout.height * (domain.y[1] - domain.y[0]));

    var pad = layout.margin || {l: 80, r: 80, t: 100, b: 80};
    var rowContentWidth = groupWidth;
    var rowHeight = groupHeight;

    return {
        key: i,
        colCount: dimensions.filter(visible).length,
        dimensions: dimensions,
        tickDistance: c.tickDistance,
        unitToColor: unitToColorScale(cscale),
        lines: lines,
        labelFont: labelFont,
        tickFont: tickFont,
        rangeFont: rangeFont,
        layoutWidth: width,
        layoutHeight: layout.height,
        domain: domain,
        translateX: domain.x[0] * width,
        translateY: layout.height - domain.y[1] * layout.height,
        pad: pad,
        canvasWidth: rowContentWidth * c.canvasPixelRatio + 2 * lines.canvasOverdrag,
        canvasHeight: rowHeight * c.canvasPixelRatio,
        width: rowContentWidth,
        height: rowHeight,
        canvasPixelRatio: c.canvasPixelRatio
    };
}

function viewModel(state, callbacks, model) {

    var width = model.width;
    var height = model.height;
    var dimensions = model.dimensions;
    var canvasPixelRatio = model.canvasPixelRatio;

    var xScale = function(d) {return width * d / Math.max(1, model.colCount - 1);};

    var unitPad = c.verticalPadding / (height * canvasPixelRatio);
    var unitPadScale = (1 - 2 * unitPad);
    function paddedUnitScale(d) { return unitPad + unitPadScale * d; }
    function invertPaddedUnitScale(d) { return (d - unitPad) / unitPadScale; }
    var uScaleInOrder = unitScaleInOrder(height, c.verticalPadding);

    var viewModel = {
        key: model.key,
        xScale: xScale,
        model: model,
        inBrushDrag: false // consider factoring it out and putting it in a centralized global-ish gesture state object
    };

    var uniqueKeys = {};

    viewModel.dimensions = dimensions.filter(visible).map(function(dimension, i) {
        var domainToUnit = domainToUnitScale(dimension);
        var foundKey = uniqueKeys[dimension.label];
        uniqueKeys[dimension.label] = (foundKey || 0) + 1;
        var key = dimension.label + (foundKey ? '__' + foundKey : '');
        var uScale = unitScale(height, c.verticalPadding);
        var specifiedConstraint = dimension.constraintrange;
        var filterRangeSpecified = specifiedConstraint && specifiedConstraint.length > 0;
        var filterRange = filterRangeSpecified ? specifiedConstraint.map(function(d) {return d.map(domainToUnit).map(paddedUnitScale);}) : [[0, 1]];
        var brushMove = function() {
            var p = viewModel;
            p.focusLayer && p.focusLayer.render(p.panels, true);
            var filtersActive = someFiltersActive(p);
            if(!state.contextShown() && filtersActive) {
                p.contextLayer && p.contextLayer.render(p.panels, true);
                state.contextShown(true);
            } else if(state.contextShown() && !filtersActive) {
                p.contextLayer && p.contextLayer.render(p.panels, true, true);
                state.contextShown(false);
            }
        };

        var truncatedValues = dimension.values;
        if(truncatedValues.length > dimension._length) {
            truncatedValues = truncatedValues.slice(0, dimension._length);
        }

        return {
            key: key,
            label: dimension.label,
            tickFormat: dimension.tickformat,
            tickvals: dimension.tickvals,
            ticktext: dimension.ticktext,
            ordinal: !!dimension.tickvals,
            multiselect: dimension.multiselect,
            xIndex: i,
            crossfilterDimensionIndex: i,
            visibleIndex: dimension._index,
            height: height,
            values: truncatedValues,
            paddedUnitValues: truncatedValues.map(domainToUnit).map(paddedUnitScale),
            xScale: xScale,
            x: xScale(i),
            canvasX: xScale(i) * canvasPixelRatio,
            // fixme remove the old unitScale
            unitScale: uScale,
            unitScaleInOrder: uScaleInOrder,
            domainScale: domainScale(height, c.verticalPadding, dimension),
            ordinalScale: ordinalScale(dimension),
            domainToUnitScale: domainToUnit,
            parent: viewModel,
            model: model,
            brush: brush.makeBrush(
                state,
                filterRangeSpecified,
                filterRange,
                function() {
                    state.linePickActive(false);
                },
                brushMove,
                function(f) {
                    var p = viewModel;
                    p.focusLayer.render(p.panels, true);
                    p.pickLayer && p.pickLayer.render(p.panels, true);
                    state.linePickActive(true);
                    if(callbacks && callbacks.filterChanged) {
                        var invScale = domainToUnit.invert;

                        // update gd.data as if a Plotly.restyle were fired
                        var newRanges = f.map(function(r) {return r.map(invertPaddedUnitScale).map(invScale);});
                        callbacks.filterChanged(p.key, dimension._index, newRanges);
                    }
                }
            )
        };
    });

    return viewModel;
}

function styleExtentTexts(selection) {
    selection
        .classed(c.cn.axisExtentText, true)
        .attr('text-anchor', 'middle')
        .style('cursor', 'default')
        .style('user-select', 'none');
}

function enterSvgDefs(root) {
    var defs = root.selectAll('defs')
        .data(repeat, keyFun);

    defs.enter()
        .append('defs');

    brush.addFilterBarDefs(defs);
}

function parcoordsInteractionState() {
    var linePickActive = true;
    var contextShown = false;
    return {
        linePickActive: function(val) {return arguments.length ? linePickActive = !!val : linePickActive;},
        contextShown: function(val) {return arguments.length ? contextShown = !!val : contextShown;}
    };
}

module.exports = function(root, svg, parcoordsLineLayers, styledData, layout, callbacks) {

    var state = parcoordsInteractionState();

    var vm = styledData
        .filter(function(d) { return unwrap(d).trace.visible; })
        .map(model.bind(0, layout))
        .map(viewModel.bind(0, state, callbacks));

    parcoordsLineLayers.each(function(d, i) {
        return Lib.extendFlat(d, vm[i]);
    });

    var parcoordsLineLayer = parcoordsLineLayers.selectAll('.gl-canvas')
        .each(function(d) {
            // FIXME: figure out how to handle multiple instances
            d.viewModel = vm[0];
            d.model = d.viewModel ? d.viewModel.model : null;
        });

    var lastHovered = null;

    var pickLayer = parcoordsLineLayer.filter(function(d) {return d.pick;});

    // emit hover / unhover event
    pickLayer
        .style('pointer-events', 'auto')
        .on('mousemove', function(d) {
            if(state.linePickActive() && d.lineLayer && callbacks && callbacks.hover) {
                var event = d3.event;
                var cw = this.width;
                var ch = this.height;
                var pointer = d3.mouse(this);
                var x = pointer[0];
                var y = pointer[1];

                if(x < 0 || y < 0 || x >= cw || y >= ch) {
                    return;
                }
                var pixel = d.lineLayer.readPixel(x, ch - 1 - y);
                var found = pixel[3] !== 0;
                // inverse of the calcPickColor in `lines.js`; detailed comment there
                var curveNumber = found ? pixel[2] + 256 * (pixel[1] + 256 * pixel[0]) : null;
                var eventData = {
                    x: x,
                    y: y,
                    clientX: event.clientX,
                    clientY: event.clientY,
                    dataIndex: d.model.key,
                    curveNumber: curveNumber
                };
                if(curveNumber !== lastHovered) { // don't unnecessarily repeat the same hit (or miss)
                    if(found) {
                        callbacks.hover(eventData);
                    } else if(callbacks.unhover) {
                        callbacks.unhover(eventData);
                    }
                    lastHovered = curveNumber;
                }
            }
        });

    parcoordsLineLayer
        .style('opacity', function(d) {return d.pick ? 0.01 : 1;});

    svg.style('background', 'rgba(255, 255, 255, 0)');
    var parcoordsControlOverlay = svg.selectAll('.' + c.cn.parcoords)
        .data(vm, keyFun);

    parcoordsControlOverlay.exit().remove();

    parcoordsControlOverlay.enter()
        .append('g')
        .classed(c.cn.parcoords, true)
        .attr('overflow', 'visible')
        .style('box-sizing', 'content-box')
        .style('position', 'absolute')
        .style('left', 0)
        .style('overflow', 'visible')
        .style('shape-rendering', 'crispEdges')
        .style('pointer-events', 'none')
        .call(enterSvgDefs);

    parcoordsControlOverlay
        .attr('width', function(d) {return d.model.width + d.model.pad.l + d.model.pad.r;})
        .attr('height', function(d) {return d.model.height + d.model.pad.t + d.model.pad.b;})
        .attr('transform', function(d) {
            return 'translate(' + d.model.translateX + ',' + d.model.translateY + ')';
        });

    var parcoordsControlView = parcoordsControlOverlay.selectAll('.' + c.cn.parcoordsControlView)
        .data(repeat, keyFun);

    parcoordsControlView.enter()
        .append('g')
        .classed(c.cn.parcoordsControlView, true)
        .style('box-sizing', 'content-box');

    parcoordsControlView
        .attr('transform', function(d) {return 'translate(' + d.model.pad.l + ',' + d.model.pad.t + ')';});

    var yAxis = parcoordsControlView.selectAll('.' + c.cn.yAxis)
        .data(function(vm) {return vm.dimensions;}, keyFun);

    function updatePanelLayout(yAxis, vm) {
        var panels = vm.panels || (vm.panels = []);
        var yAxes = yAxis.each(function(d) {return d;})[vm.key].map(function(e) {return e.__data__;});
        var panelCount = yAxes.length - 1;
        var rowCount = 1;
        for(var row = 0; row < rowCount; row++) {
            for(var p = 0; p < panelCount; p++) {
                var panel = panels[p + row * panelCount] || (panels[p + row * panelCount] = {});
                var dim1 = yAxes[p];
                var dim2 = yAxes[p + 1];
                panel.dim1 = dim1;
                panel.dim2 = dim2;
                panel.canvasX = dim1.canvasX;
                panel.panelSizeX = dim2.canvasX - dim1.canvasX;
                panel.panelSizeY = vm.model.canvasHeight / rowCount;
                panel.y = row * panel.panelSizeY;
                panel.canvasY = vm.model.canvasHeight - panel.y - panel.panelSizeY;
            }
        }
    }

    yAxis.enter()
        .append('g')
        .classed(c.cn.yAxis, true);

    parcoordsControlView.each(function(vm) {
        updatePanelLayout(yAxis, vm);
    });

    parcoordsLineLayer
        .filter(function(d) {return !!d.viewModel;})
        .each(function(d) {
            d.lineLayer = lineLayerMaker(this, d);
            d.viewModel[d.key] = d.lineLayer;
            d.lineLayer.render(d.viewModel.panels, !d.context);
        });

    yAxis
        .attr('transform', function(d) {return 'translate(' + d.xScale(d.xIndex) + ', 0)';});

    // drag column for reordering columns
    yAxis
        .call(d3.behavior.drag()
            .origin(function(d) {return d;})
            .on('drag', function(d) {
                var p = d.parent;
                state.linePickActive(false);
                d.x = Math.max(-c.overdrag, Math.min(d.model.width + c.overdrag, d3.event.x));
                d.canvasX = d.x * d.model.canvasPixelRatio;
                yAxis
                    .sort(function(a, b) {return a.x - b.x;})
                    .each(function(dd, i) {
                        dd.xIndex = i;
                        dd.x = d === dd ? dd.x : dd.xScale(dd.xIndex);
                        dd.canvasX = dd.x * dd.model.canvasPixelRatio;
                    });

                updatePanelLayout(yAxis, p);

                yAxis.filter(function(dd) {return Math.abs(d.xIndex - dd.xIndex) !== 0;})
                    .attr('transform', function(d) {return 'translate(' + d.xScale(d.xIndex) + ', 0)';});
                d3.select(this).attr('transform', 'translate(' + d.x + ', 0)');
                yAxis.each(function(dd, i, ii) {if(ii === d.parent.key) p.dimensions[i] = dd;});
                p.contextLayer && p.contextLayer.render(p.panels, false, !someFiltersActive(p));
                p.focusLayer.render && p.focusLayer.render(p.panels);
            })
            .on('dragend', function(d) {
                var p = d.parent;
                d.x = d.xScale(d.xIndex);
                d.canvasX = d.x * d.model.canvasPixelRatio;
                updatePanelLayout(yAxis, p);
                d3.select(this)
                    .attr('transform', function(d) {return 'translate(' + d.x + ', 0)';});
                p.contextLayer && p.contextLayer.render(p.panels, false, !someFiltersActive(p));
                p.focusLayer && p.focusLayer.render(p.panels);
                p.pickLayer && p.pickLayer.render(p.panels, true);
                state.linePickActive(true);

                if(callbacks && callbacks.axesMoved) {
                    callbacks.axesMoved(p.key, p.dimensions.map(function(dd) {return dd.crossfilterDimensionIndex;}));
                }
            })
        );

    yAxis.exit()
        .remove();

    var axisOverlays = yAxis.selectAll('.' + c.cn.axisOverlays)
        .data(repeat, keyFun);

    axisOverlays.enter()
        .append('g')
        .classed(c.cn.axisOverlays, true);

    axisOverlays.selectAll('.' + c.cn.axis).remove();

    var axis = axisOverlays.selectAll('.' + c.cn.axis)
        .data(repeat, keyFun);

    axis.enter()
        .append('g')
        .classed(c.cn.axis, true);

    axis
        .each(function(d) {
            var wantedTickCount = d.model.height / d.model.tickDistance;
            var scale = d.domainScale;
            var sdom = scale.domain();
            d3.select(this)
                .call(d3.svg.axis()
                    .orient('left')
                    .tickSize(4)
                    .outerTickSize(2)
                    .ticks(wantedTickCount, d.tickFormat) // works for continuous scales only...
                    .tickValues(d.ordinal ? // and this works for ordinal scales
                        sdom :
                        null)
                    .tickFormat(d.ordinal ? function(d) {return d;} : null)
                    .scale(scale));
            Drawing.font(axis.selectAll('text'), d.model.tickFont);
        });

    axis
        .selectAll('.domain, .tick>line')
        .attr('fill', 'none')
        .attr('stroke', 'black')
        .attr('stroke-opacity', 0.25)
        .attr('stroke-width', '1px');

    axis
        .selectAll('text')
        .style('text-shadow', '1px 1px 1px #fff, -1px -1px 1px #fff, 1px -1px 1px #fff, -1px 1px 1px #fff')
        .style('cursor', 'default')
        .style('user-select', 'none');

    var axisHeading = axisOverlays.selectAll('.' + c.cn.axisHeading)
        .data(repeat, keyFun);

    axisHeading.enter()
        .append('g')
        .classed(c.cn.axisHeading, true);

    var axisTitle = axisHeading.selectAll('.' + c.cn.axisTitle)
        .data(repeat, keyFun);

    axisTitle.enter()
        .append('text')
        .classed(c.cn.axisTitle, true)
        .attr('text-anchor', 'middle')
        .style('cursor', 'ew-resize')
        .style('user-select', 'none')
        .style('pointer-events', 'auto');

    axisTitle
        .attr('transform', 'translate(0,' + -c.axisTitleOffset + ')')
        .text(function(d) {return d.label;})
        .each(function(d) {Drawing.font(axisTitle, d.model.labelFont);});

    var axisExtent = axisOverlays.selectAll('.' + c.cn.axisExtent)
        .data(repeat, keyFun);

    axisExtent.enter()
        .append('g')
        .classed(c.cn.axisExtent, true);

    var axisExtentTop = axisExtent.selectAll('.' + c.cn.axisExtentTop)
        .data(repeat, keyFun);

    axisExtentTop.enter()
        .append('g')
        .classed(c.cn.axisExtentTop, true);

    axisExtentTop
        .attr('transform', 'translate(' + 0 + ',' + -c.axisExtentOffset + ')');

    var axisExtentTopText = axisExtentTop.selectAll('.' + c.cn.axisExtentTopText)
        .data(repeat, keyFun);

    function formatExtreme(d) {
        return d.ordinal ? function() {return '';} : d3.format(d.tickFormat);
    }

    axisExtentTopText.enter()
        .append('text')
        .classed(c.cn.axisExtentTopText, true)
        .call(styleExtentTexts);

    axisExtentTopText
        .text(function(d) {return formatExtreme(d)(d.domainScale.domain().slice(-1)[0]);})
        .each(function(d) {Drawing.font(axisExtentTopText, d.model.rangeFont);});

    var axisExtentBottom = axisExtent.selectAll('.' + c.cn.axisExtentBottom)
        .data(repeat, keyFun);

    axisExtentBottom.enter()
        .append('g')
        .classed(c.cn.axisExtentBottom, true);

    axisExtentBottom
        .attr('transform', function(d) {return 'translate(' + 0 + ',' + (d.model.height + c.axisExtentOffset) + ')';});

    var axisExtentBottomText = axisExtentBottom.selectAll('.' + c.cn.axisExtentBottomText)
        .data(repeat, keyFun);

    axisExtentBottomText.enter()
        .append('text')
        .classed(c.cn.axisExtentBottomText, true)
        .attr('dy', '0.75em')
        .call(styleExtentTexts);

    axisExtentBottomText
        .text(function(d) {return formatExtreme(d)(d.domainScale.domain()[0]);})
        .each(function(d) {Drawing.font(axisExtentBottomText, d.model.rangeFont);});

    brush.ensureAxisBrush(axisOverlays);
};
