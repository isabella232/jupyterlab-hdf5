// Copyright (c) Max Klein.
// Distributed under the terms of the Modified BSD License.

import { PromiseDelegate, Token } from "@phosphor/coreutils";

import { DataGrid, DataModel } from "@phosphor/datagrid";

import {
  IWidgetTracker,
  MainAreaWidget,
  Toolbar,
  ToolbarButton
} from "@jupyterlab/apputils";

import {
  ABCWidgetFactory,
  DocumentRegistry,
  DocumentWidget,
  IDocumentWidget
} from "@jupyterlab/docregistry";

import { ServerConnection } from "@jupyterlab/services";

import {
  HdfContents,
  hdfContentsRequest,
  hdfDataRequest,
  IContentsParameters,
  parseHdfQuery,
  IDatasetContent
} from "./hdf";
import { SliceInput } from "./toolbar";

/**
 * The CSS class for the data grid widget.
 */
export const HDF_CLASS = "jp-HdfDataGrid";

/**
 * The CSS class for our HDF5 container.
 */
export const HDF_CONTAINER_CLASS = "jp-HdfContainer";

interface ISlice {
  start: number | null;
  stop?: number | null;
  step?: number | null;
}

export const parseSlice = (slicestr: string): ISlice[] => {
  let parsed: ISlice[] = [];

  return slicestr
    .split(/\s*,\s*/)
    .map(dim => dim.split(/\s*:\s*/))
    .reduce((parsed, slice) => {
      // don't treat single indices as slices
      if (slice.length === 0) {
        parsed.push({ start: null as any, stop: null as any });
      } else if (slice.length === 2 || slice.length === 3) {
        parsed.push({ start: parseInt(slice[0]), stop: parseInt(slice[1]) });
      }
      return parsed;
    }, parsed);
};

/**
 * Base implementation of a dataset model
 */
export class HdfDatasetModelBase extends DataModel {
  constructor() {
    super();

    this._serverSettings = ServerConnection.makeSettings();
  }

  /**
   * A promise that resolves when the file editor is ready.
   */
  get ready(): Promise<void> {
    return this._ready.promise;
  }

  /**
   * Handle actions that should be taken when the context is ready.
   */
  init(content: { fpath: string; uri: string } & IDatasetContent): void {
    const { fpath, uri, shape } = content;

    this._fpath = fpath;
    this._uri = uri;

    this._rowCount = shape[0];
    this._colCount = shape[1];

    this.emitChanged({
      type: "rows-inserted",
      region: "body",
      index: 0,
      span: this._rowCount
    });
    this.emitChanged({
      type: "columns-inserted",
      region: "body",
      index: 0,
      span: this._colCount
    });

    // Resolve the ready promise.
    this._ready.resolve(undefined);
  }

  columnCount(region: DataModel.ColumnRegion): number {
    if (region === "body") {
      if (this._colSlice && this._colSlice.start && this._colSlice.stop) {
        return this._colSlice.stop - this._colSlice.start;
      } else {
        return this._colCount;
      }
    }

    return 1;
  }

  rowCount(region: DataModel.RowRegion): number {
    if (region === "body") {
      if (this._rowSlice && this._rowSlice.start && this._rowSlice.stop) {
        return this._rowSlice.stop - this._rowSlice.start;
      } else {
        return this._rowCount;
      }
    }

    return 1;
  }

  data(region: DataModel.CellRegion, row: number, col: number): any {
    // adjust row and col based on slice
    if (this._rowSlice && this._rowSlice.start && this._rowSlice.stop) {
      row += this._rowSlice.start;
    }
    if (this._colSlice && this._colSlice.start && this._colSlice.stop) {
      col += this._colSlice.start;
    }

    if (region === "row-header") {
      return `${row}`;
    }
    if (region === "column-header") {
      return `${col}`;
    }
    if (region === "corner-header") {
      return null;
    }
    const relRow = row % this._blockSize;
    const relCol = col % this._blockSize;
    const rowBlock = (row - relRow) / this._blockSize;
    const colBlock = (col - relCol) / this._blockSize;
    if (this._blocks[rowBlock]) {
      const block = this._blocks[rowBlock][colBlock];
      if (block !== "busy") {
        if (block) {
          // This data has already been loaded.
          return this._blocks[rowBlock][colBlock][relRow][relCol];
        } else {
          // This data has not yet been loaded, load it.
          this._fetchBlock(rowBlock, colBlock);
        }
      }
    } else {
      // This data has not yet been loaded, load it.
      this._blocks[rowBlock] = Object();
      this._fetchBlock(rowBlock, colBlock);
    }
    return null;
  }

  get slice(): string {
    return this._slice;
  }
  set slice(s: string) {
    this._slice = s;

    const parts = parseSlice(s);
    this._rowSlice = parts[0];
    this._colSlice = parts[1];

    this.emitChanged({
      type: "model-reset"
    });

    this.emitChanged({
      type: "rows-inserted",
      region: "body",
      index: 0,
      span: this.rowCount("body")
    });
    this.emitChanged({
      type: "columns-inserted",
      region: "body",
      index: 0,
      span: this.columnCount("body")
    });

    this._blocks = Object();
  }

  /**
   * fetch a data block. When data is received,
   * the grid will be updated by emitChanged.
   */
  private _fetchBlock = (rowBlock: number, colBlock: number) => {
    this._blocks[rowBlock][colBlock] = "busy";

    const rowStart: number = rowBlock * this._blockSize;
    const rowStop: number = Math.min(
      rowStart + this._blockSize,
      this._rowCount
    );
    const colStart: number = colBlock * this._blockSize;
    const colStop: number = Math.min(
      colStart + this._blockSize,
      this._colCount
    );

    const params = {
      fpath: this._fpath,
      uri: this._uri,
      col: [colStart, colStop],
      row: [rowStart, rowStop]
    };
    hdfDataRequest(params, this._serverSettings).then(data => {
      this._blocks[rowBlock][colBlock] = data;
      this.emitChanged({
        type: "cells-changed",
        region: "body",
        rowIndex: rowBlock * this._blockSize,
        columnIndex: colBlock * this._blockSize,
        rowSpan: this._blockSize,
        columnSpan: this._blockSize
      });
    });
  };

  protected _serverSettings: ServerConnection.ISettings;

  private _fpath: string = "";
  private _uri: string = "";

  private _slice: string = "";
  private _colSlice: ISlice = { start: null, stop: null };
  private _rowSlice: ISlice = { start: null, stop: null };

  private _blocks: any = Object();
  private _blockSize: number = 100;
  private _colCount: number = 0;
  private _rowCount: number = 0;

  private _ready = new PromiseDelegate<void>();
}

/**
 * Subclass that constructs a dataset model from a document context
 */
class HdfDatasetModelContext extends HdfDatasetModelBase {
  constructor(context: DocumentRegistry.Context) {
    super();

    this._context = context;

    void context.ready.then(() => {
      this._onContextReady();
    });
  }

  /**
   * Get the context for the editor widget.
   */
  get context(): DocumentRegistry.Context {
    return this._context;
  }

  /**
   * Handle actions that should be taken when the context is ready.
   */
  private _onContextReady(): void {
    // get the fpath and the uri for this dataset
    const { fpath, uri } = parseHdfQuery(this._context.contentsModel.path);

    // unpack the content
    const content: IDatasetContent = this._context.model.toJSON() as any;

    // // Wire signal connections.
    // contextModel.contentChanged.connect(this._onContentChanged, this);

    this.init({ ...content, fpath, uri });
  }

  protected _context: DocumentRegistry.Context;
}

/**
 * Subclass that constructs a dataset model from simple parameters
 */
class HdfDatasetModelParams extends HdfDatasetModelBase {
  constructor(parameters: IContentsParameters) {
    super();

    hdfContentsRequest(parameters, this._serverSettings).then(hdfContents => {
      this._onMetaReady(parameters, hdfContents as HdfContents);
    });
  }

  /**
   * Handle actions that should be taken when the model is ready.
   */
  private _onMetaReady(
    parameters: IContentsParameters,
    contents: HdfContents
  ): void {
    const { fpath, uri } = parameters;
    this.init({ ...contents.content, fpath, uri });
  }
}

export function createHdfGrid(params: {
  fpath: string;
  uri: string;
}): DataGrid {
  const model = new HdfDatasetModelParams(params);

  const grid = new DataGrid();
  grid.model = model;

  return grid;
}

/**
 * A mainarea widget for HDF content widgets.
 */
export class HdfDatasetMain extends MainAreaWidget<DataGrid> {
  constructor(params: { fpath: string; uri: string }) {
    const content = createHdfGrid(params);

    const toolbar = Private.createToolbar(content);
    const reveal = (content.model as HdfDatasetModelParams).ready;
    super({ content, reveal, toolbar });
  }
}

/**
 * A document widget for HDF content widgets.
 */
export class HdfDatasetDoc extends DocumentWidget<DataGrid>
  implements IDocumentWidget<DataGrid> {
  constructor(context: DocumentRegistry.Context) {
    const content = new DataGrid();
    content.model = new HdfDatasetModelContext(context);
    const toolbar = Private.createToolbar(content);
    const reveal = context.ready;
    super({ content, context, reveal, toolbar });
  }
}

/**
 * A widget factory for HDF5 data grids.
 */
export class HdfDatasetDocFactory extends ABCWidgetFactory<HdfDatasetDoc> {
  /**
   * Create a new widget given a context.
   */
  protected createNewWidget(context: DocumentRegistry.Context): HdfDatasetDoc {
    return new HdfDatasetDoc(context);
  }
}

/**
 * A class that tracks hdf5 dataset document widgets.
 */
export interface IHdfDatasetDocTracker extends IWidgetTracker<HdfDatasetDoc> {}

export const IHdfDatasetDocTracker = new Token<IHdfDatasetDocTracker>(
  "jupyterlab-hdf:IHdfDatasetTracker"
);

/**
 * A namespace for HDFViewer statics.
 */
export namespace HDFViewer {
  /**
   * The options for a SyncTeX edit command,
   * mapping the hdf position to an editor position.
   */
  export interface IPosition {
    /**
     * The page of the hdf.
     */
    page: number;

    /**
     * The x-position on the page, in pts, where
     * the HDF is assumed to be 72dpi.
     */
    x: number;

    /**
     * The y-position on the page, in pts, where
     * the HDF is assumed to be 72dpi.
     */
    y: number;
  }
}

/**
 * A namespace for HDF widget private data.
 */
namespace Private {
  /**
   * Create the node for the HDF widget.
   */
  export function createNode(): HTMLElement {
    let node = document.createElement("div");
    node.className = HDF_CONTAINER_CLASS;
    let hdf = document.createElement("div");
    hdf.className = HDF_CLASS;
    node.appendChild(hdf);
    node.tabIndex = -1;
    return node;
  }

  /**
   * Create the toolbar for the HDF viewer.
   */
  export function createToolbar(grid: DataGrid): Toolbar<ToolbarButton> {
    const toolbar = new Toolbar();

    toolbar.addClass("jp-Toolbar");
    toolbar.addClass("jp-Hdf-toolbar");

    toolbar.addItem("slice input", new SliceInput(grid));

    // toolbar.addItem(
    //   'previous',
    //   new ToolbarButton({
    //     iconClassName: 'jp-PreviousIcon jp-Icon jp-Icon-16',
    //     onClick: () => {
    //       hdfViewer.currentPageNumber = Math.max(
    //         hdfViewer.currentPageNumber - 1,
    //         1
    //       );
    //     },
    //     tooltip: 'Previous Page'
    //   })
    // );
    // toolbar.addItem(
    //   'next',
    //   new ToolbarButton({
    //     iconClassName: 'jp-NextIcon jp-Icon jp-Icon-16',
    //     onClick: () => {
    //       hdfViewer.currentPageNumber = Math.min(
    //         hdfViewer.currentPageNumber + 1,
    //         hdfViewer.pagesCount
    //       );
    //     },
    //     tooltip: 'Next Page'
    //   })
    // );
    //
    // toolbar.addItem('spacer', Toolbar.createSpacerItem());

    return toolbar;
  }
}
