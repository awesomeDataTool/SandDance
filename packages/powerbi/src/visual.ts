/*
*  Power BI Visual CLI
*
*  Copyright (c) Microsoft Corporation
*  All rights reserved.
*  MIT License
*
*  Permission is hereby granted, free of charge, to any person obtaining a copy
*  of this software and associated documentation files (the ""Software""), to deal
*  in the Software without restriction, including without limitation the rights
*  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
*  copies of the Software, and to permit persons to whom the Software is
*  furnished to do so, subject to the following conditions:
*
*  The above copyright notice and this permission notice shall be included in
*  all copies or substantial portions of the Software.
*
*  THE SOFTWARE IS PROVIDED *AS IS*, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
*  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
*  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
*  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
*  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
*  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
*  THE SOFTWARE.
*/
'use strict';

import 'core-js/stable';
import 'regenerator-runtime/runtime';
import './../style/visual.less';
import powerbiVisualsApi from 'powerbi-visuals-api';
import VisualConstructorOptions = powerbiVisualsApi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbiVisualsApi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbiVisualsApi.extensibility.visual.IVisual;
import EnumerateVisualObjectInstancesOptions = powerbiVisualsApi.EnumerateVisualObjectInstancesOptions;
import VisualObjectInstance = powerbiVisualsApi.VisualObjectInstance;
import DataView = powerbiVisualsApi.DataView;
import VisualObjectInstanceEnumerationObject = powerbiVisualsApi.VisualObjectInstanceEnumerationObject;

import * as powerbiModels from 'powerbi-models';

import { capabilities, SandDance } from '@msrvida/sanddance-explorer';
import { convertFilter } from './convertFilter';
import { createElement } from 'react';
import { render } from 'react-dom';
import { App, Props } from './app';
import { convertTableToObjectArray } from './convertTableToObjectArray';
import { cleanInsight } from './cleanInsight';
import { VisualSettings, SandDanceConfig, IVisualSettings } from './settings';

const { util } = SandDance.VegaDeckGl;

export class Visual implements IVisual {
    private settings: VisualSettings;
    private viewElement: HTMLElement;
    private errorElement: HTMLElement;
    private events: powerbiVisualsApi.extensibility.IVisualEventService;
    private renderingOptions: VisualUpdateOptions;
    private app: App;
    private prevSettings: IVisualSettings;
    private host: powerbiVisualsApi.extensibility.visual.IVisualHost;
    private selectionManager: powerbiVisualsApi.extensibility.ISelectionManager;
    private fetchMoreTimer: number;
    private filters: { sd: SandDance.types.Search, pbi: powerbiModels.IFilter[] };
    private columns: powerbiVisualsApi.DataViewMetadataColumn[];

    public static fetchMoreTimeout = 5000;

    constructor(options: VisualConstructorOptions) {
        // console.log('Visual constructor', options);
        this.host = options.host;
        this.events = this.host.eventService;
        this.selectionManager = this.host.createSelectionManager();

        if (typeof document !== 'undefined') {
            options.element.style.position = 'relative';
            this.viewElement = util.addDiv(options.element, 'sanddance-powerbi');
            this.errorElement = util.addDiv(options.element, 'sanddance-error');
            this.errorElement.style.position = 'absolute';

            const props: Props = {
                mounted: (app: App) => {
                    this.app = app;
                },
                onViewChange: (tooltipExclusions: string[]) => {
                    // console.log('onViewChange');
                    if (this.renderingOptions) {
                        this.events.renderingFinished(this.renderingOptions);
                        this.renderingOptions = null;
                    }

                    if (this.renderingOptions.viewMode === powerbiVisualsApi.ViewMode.Edit || this.renderingOptions.viewMode === powerbiVisualsApi.ViewMode.InFocusEdit) {
                        const insight = this.app.explorer.viewer.getInsight();
                        tooltipExclusions = tooltipExclusions || this.app.explorer.state.tooltipExclusions;
                        cleanInsight(insight);
                        const config: SandDanceConfig = {
                            insightJSON: JSON.stringify(insight),
                            tooltipExclusionsJSON: JSON.stringify(tooltipExclusions)
                        };
                        const properties = config as any;
                        this.host.persistProperties({ replace: [{ objectName: 'sandDanceConfig', properties, selector: null }] });
                    }
                },
                onError: (e: any) => {
                    if (this.renderingOptions) {
                        this.events.renderingFailed(this.renderingOptions);
                        this.renderingOptions = null;
                    }
                },
                onDataFilter: (searchFilter, filteredData) => {
                    // console.log('onDataFilter', filteredData);
                    if (filteredData) {
                        const result = convertFilter(searchFilter, this.columns, filteredData);
                        this.applySelection(result.selectedIds);
                        this.applyFilters(result.filters);
                        this.filters = { sd: searchFilter, pbi: result.filters };
                    } else {
                        this.filters = null;
                        this.clearFilter();
                        this.clearSelection();
                    }
                },
                onSelectionChanged: (searchFilter, activeIndex, selectedData) => {
                    // console.log('onDataSelected', selectedData);
                    if (selectedData) {
                        const result = convertFilter(searchFilter, this.columns, selectedData);
                        this.applySelection(result.selectedIds);
                        this.applyFilters(this.filters ? this.filters.pbi.concat(result.filters) : result.filters);
                    } else {
                        this.clearSelection();
                        // revert to filtered if it exists
                        if (this.filters) {
                            this.applyFilters(this.filters.pbi);
                        } else {
                            this.clearFilter();
                        }
                    }
                }
            };
            render(createElement(App, props), this.viewElement);
        }
    }

    applySelection(selectedIds: powerbiVisualsApi.extensibility.ISelectionId[]) {
        if (selectedIds.length) {
            this.selectionManager.select(selectedIds, false);
        } else {
            this.clearSelection();
        }
    }

    clearSelection() {
        this.selectionManager.clear();
    }

    applyFilters(filters: powerbiModels.IFilter[]) {
        this.host.applyJsonFilter(null, "general", "filter", powerbiVisualsApi.FilterAction.merge);
        this.host.applyJsonFilter(filters, "general", "filter", powerbiVisualsApi.FilterAction.merge);
    }

    clearFilter() {
        this.applyFilters(null);
    }

    destroy() {
        this.app && this.app.finalize();
        this.app = null;
    }

    public update(options: VisualUpdateOptions) {
        // console.log('Visual update', options);

        this.renderingOptions = options;
        this.events.renderingStarted(this.renderingOptions);

        if (this.fetchMoreTimer) {
            clearTimeout(this.fetchMoreTimer);
        }

        if (!capabilities.webgl) {
            this.app.unload();
            return;
        }

        const dataView = options && options.dataViews && options.dataViews[0];
        if (!dataView || !dataView.table) {
            this.app.unload();
        } else {
            this.columns = dataView.metadata.columns;
            let doneFetching = true;
            if (dataView.metadata.segment) {
                doneFetching = !this.host.fetchMoreData();
            }
            this.app.fetchStatus(dataView.table.rows.length, !doneFetching);
            if (doneFetching) {
                this.show(dataView);
            } else {
                this.fetchMoreTimer = window.setTimeout(() => {
                    // console.log('Visual fetchMoreTimeout', options);

                    this.app.fetchStatus(dataView.table.rows.length, false);
                    this.show(dataView);

                }, Visual.fetchMoreTimeout);
            }
        }
    }

    show(dataView: powerbiVisualsApi.DataView) {
        this.settings = Visual.parseSettings(dataView);
        const oldData = this.app.getDataContent();
        let { data, different } = convertTableToObjectArray(dataView.table, oldData, this.host);
        if (!this.prevSettings) {
            different = true;
        }

        this.app.setChromeless(!this.settings.sandDanceMainSettings.showchrome);

        this.prevSettings = util.clone(this.settings);

        if (!different) {
            // console.log('Visual update - not different');
            return;
        }

        const { sandDanceConfig } = this.settings;

        let tooltipExclusions: string[] = [];

        if (sandDanceConfig.tooltipExclusionsJSON) {
            try {
                tooltipExclusions = JSON.parse(sandDanceConfig.tooltipExclusionsJSON);
            } catch (e) {
                // continue regardless of error
            }
        }

        this.app.load(data, columns => {
            if (!columns) return;

            let insight: Partial<SandDance.types.Insight>;

            if (sandDanceConfig.insightJSON) {
                try {
                    insight = JSON.parse(sandDanceConfig.insightJSON);
                    delete insight.size;
                } catch (e) {
                    // continue regardless of error
                }
            }

            if (this.filters) {
                insight.filter = this.filters.sd;
            }

            return insight;
        }, tooltipExclusions);

    }

    private static parseSettings(dataView: DataView): VisualSettings {
        return VisualSettings.parse(dataView) as VisualSettings;
    }

    /**
     * This function gets called for each of the objects defined in the capabilities files and allows you to select which of the
     * objects and properties you want to expose to the users in the property pane.
     *
     */
    public enumerateObjectInstances(options: EnumerateVisualObjectInstancesOptions): VisualObjectInstance[] | VisualObjectInstanceEnumerationObject {
        if (options.objectName === 'sandDanceConfig') return [];
        return VisualSettings.enumerateObjectInstances(this.settings || VisualSettings.getDefault(), options);
    }
}
