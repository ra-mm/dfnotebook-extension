import { Dialog, showDialog } from '@jupyterlab/apputils';
import {
    CodeCell,
  type Cell,
  type ICodeCellModel,
  type MarkdownCell
} from '@jupyterlab/cells';
import type { KernelMessage } from '@jupyterlab/services';
import { nullTranslator } from '@jupyterlab/translation';
import { findIndex } from '@lumino/algorithm';
import { KernelError, INotebookModel, INotebookCellExecutor } from '@jupyterlab/notebook';
import { DataflowCodeCell } from '@dfnotebook/dfcells';
import { DataflowNotebookModel } from './model';

/**
 * Run a single notebook cell.
 *
 * @param options Cell execution options
 * @returns Execution status
 */
  export async function runCell({
    cell,
    notebook,
    notebookConfig,
    onCellExecuted,
    onCellExecutionScheduled,
    sessionContext,
    sessionDialogs,
    translator
  }: INotebookCellExecutor.IRunCellOptions): Promise<boolean> {
    translator = translator ?? nullTranslator;
    const trans = translator.load('jupyterlab');
    switch (cell.model.type) {
      case 'markdown':
        (cell as MarkdownCell).rendered = true;
        cell.inputHidden = false;
        if(cell.model.metadata){
          if(cell.model.metadata.persisted_code){
            Object.keys(cell.model.metadata).forEach(key => {
              cell.model.deleteMetadata(key);
            });
          }
        }
        onCellExecuted({ cell, success: true });
        break;
      case 'code':
        if (sessionContext) {
          if (sessionContext.isTerminating) {
            await showDialog({
              title: trans.__('Kernel Terminating'),
              body: trans.__(
                'The kernel for %1 appears to be terminating. You can not run any cell for now.',
                sessionContext.session?.path
              ),
              buttons: [Dialog.okButton()]
            });
            break;
          }
          if (sessionContext.pendingInput) {
            await showDialog({
              title: trans.__('Cell not executed due to pending input'),
              body: trans.__(
                'The cell has not been executed to avoid kernel deadlock as there is another pending input! Submit your pending input and try again.'
              ),
              buttons: [Dialog.okButton()]
            });
            return false;
          }
          if (sessionContext.hasNoKernel) {
            const shouldSelect = await sessionContext.startKernel();
            if (shouldSelect && sessionDialogs) {
              await sessionDialogs.selectKernel(sessionContext);
            }
          }
  
          if (sessionContext.hasNoKernel) {
            cell.model.sharedModel.transact(() => {
              (cell.model as ICodeCellModel).clearExecution();
            });
            return true;
          }
  
          const deletedCells = notebook.deletedCells;
          onCellExecutionScheduled({ cell });
  
          let ran = false;
          try {
            let reply: KernelMessage.IExecuteReplyMsg | void;
            // !!! DATAFLOW NOTEBOOK CODE !!!
            if (notebook instanceof DataflowNotebookModel) {
                const cellUUID =  cell.model.id.replace(/-/g, '').substring(0, 8) || ''
                let dfData = getdfData(notebook, cellUUID)
                
                reply = await DataflowCodeCell.execute(
                    cell as DataflowCodeCell,
                    sessionContext,
                    {
                    deletedCells,
                    recordTiming: notebookConfig.recordTiming
                    },
                    dfData.dfMetadata,
                    dfData.cellIdModelMap
                );

                const content = (reply?.content as any);
                const all_tags: { [key: string]: string } = {}
                for (let index = 0; index < notebook.cells.length; index++){
                  const cAny = notebook.cells.get(index) as ICodeCellModel;
                  if (notebook.cells.get(index).type === 'code') {
                    const c = cAny as ICodeCellModel;
                    const cId = c.id.replace(/-/g, '').substring(0, 8);
                    if (c.getMetadata('tag')){
                      all_tags[cId] = c.getMetadata('tag');
                    }
                  }
                }

                if (content) {
                  for (let index = 0; index < notebook.cells.length; index++){
                    const cAny = notebook.cells.get(index) as ICodeCellModel;
                    if (notebook.cells.get(index).type === 'code') {
                      const c = cAny as ICodeCellModel;
                      const cId = c.id.replace(/-/g, '').substring(0, 8);
                      if(content.persistent_code[cId]){
                        notebook.cells.get(index).setMetadata('persistentCode', content.persistent_code[cId]);
                      }

                      if(content.identifier_refs[cId]){
                        let inputVarsMetadata = { 'ref': {}, 'tag_refs': {}};
                        inputVarsMetadata.ref = content.identifier_refs[cId];
                        
                        let tag_refs: { [key: string]: string } = {}
                        for (const ref_keys in content.identifier_refs[cId]){
                          if(all_tags.hasOwnProperty(ref_keys)){
                            tag_refs[ref_keys] = all_tags[ref_keys];
                          }
                        }
                        inputVarsMetadata.tag_refs = tag_refs;
                        notebook.cells.get(index).setMetadata('inputVars', inputVarsMetadata);
                      }

                      if(content.persistent_code[cId] || content.identifier_refs[cId]){
                        let cellOutputTags: string[] = [];
                        for (let i = 0; i < cAny.outputs.length; ++i) {
                          const out = c.outputs.get(i);
                          cellOutputTags.push(out.metadata['output_tag'] as string);
                        }
                        notebook.cells.get(index).setMetadata('outputVars', cellOutputTags);
                      }
                    }
                  }
                }

                let comm = sessionContext.session?.kernel?.createComm('dfcode');
                if (comm) {
                  comm.open();
                  dfData = getdfData(notebook, '');
                  comm.send({
                    'dfMetadata': dfData.dfMetadata
                  });

                  comm.onMsg = (msg) => {
                    const content = msg.content.data;
                    if (content && content.code_dict && Object.keys(content.code_dict).length > 0) {
                      for (let index = 0; index < notebook.cells.length; index++){
                        const cAny = notebook.cells.get(index) as ICodeCellModel;
                        const cId = cAny.id.replace(/-/g, '').substring(0, 8);
                        if(cAny.type == 'code' && content.code_dict.hasOwnProperty(cId)){
                          notebook.cells.get(index).sharedModel.setSource((content.code_dict as { [key: string]: any })[cId]);
                        }
                      }
                    }
                  };
                }
            } 
            else {
                reply = await CodeCell.execute(
                cell as CodeCell,
                sessionContext,
                {
                    deletedCells,
                    recordTiming: notebookConfig.recordTiming
                }
                );
            }
            // !!! END DATAFLOW NOTEBOOK CODE !!!
            deletedCells.splice(0, deletedCells.length);
  
            ran = (() => {
              if (cell.isDisposed) {
                return false;
              }
  
              if (!reply) {
                return true;
              }
              if (reply.content.status === 'ok') {
                const content = reply.content;
  
                if (content.payload && content.payload.length) {
                  handlePayload(content, notebook, cell);
                }
  
                return true;
              } else {
                throw new KernelError(reply.content);
              }
            })();
          } catch (reason) {
            if (cell.isDisposed || reason.message.startsWith('Canceled')) {
              ran = false;
            } else {
              onCellExecuted({
                cell,
                success: false,
                error: reason
              });
              throw reason;
            }
          }
  
          if (ran) {
            onCellExecuted({ cell, success: true });
          }
  
          return ran;
        }
        cell.model.sharedModel.transact(() => {
          (cell.model as ICodeCellModel).clearExecution();
        }, false);
        break;
      default:
        break;
    }
    
    return Promise.resolve(true);
  }

  export function getdfData(notebook: DataflowNotebookModel, cellUUID: string){
    const codeDict: { [key: string]: string } = {};
    const persistedCode: { [key: string]: string } = {};
    const cellIdModelMap: { [key: string]: any } = {};
    const outputTags: { [key: string]: string[] } = {};
    const inputTags: { [key: string]: string } = {};
    const allRefs: { [key: string]: {[key: string] : string[]}} = {};
    if (notebook) {
      for (let index = 0; index < notebook.cells.length; index++) {
        const cAny = notebook.cells.get(index);
        if (cAny.type === 'code') {
            const c = cAny as ICodeCellModel;
            // FIXME replace with utility function (see dfcells/widget)
            const cId = c.id.replace(/-/g, '').substring(0, 8);
            const inputTag = c.getMetadata('tag');
            if (inputTag) {
              // FIXME need to check for duplicates!
              inputTags[inputTag as string] = cId;
            }
            codeDict[cId] = c.sharedModel.getSource();
            cellIdModelMap[cId] = c;
            outputTags[cId] = c.getMetadata('outputVars')
            allRefs[cId] = c.getMetadata('inputVars');
            persistedCode[cId] = c.getMetadata('persistentCode')
        }
      };
    }
  
    const dfMetadata = {
        // FIXME replace with utility function (see dfcells/widget)
        uuid: cellUUID,
        code_dict: codeDict,
        output_tags: outputTags, // this.notebook.get_output_tags(Object.keys(code_dict)),
        input_tags: inputTags,
        auto_update_flags: {}, // this.notebook.get_auto_update_flags(),
        force_cached_flags: {}, // this.notebook.get_force_cached_flags()})
        all_refs: allRefs,
        persisted_code: persistedCode 
    };

    return { dfMetadata, cellIdModelMap };
  }
  
  /**
   * Handle payloads from an execute reply.
   *
   * #### Notes
   * Payloads are deprecated and there are no official interfaces for them in
   * the kernel type definitions.
   * See [Payloads (DEPRECATED)](https://jupyter-client.readthedocs.io/en/latest/messaging.html#payloads-deprecated).
   */
  function handlePayload(
    content: KernelMessage.IExecuteReply,
    notebook: INotebookModel,
    cell: Cell
  ) {
    const setNextInput = content.payload?.filter(i => {
      return (i as any).source === 'set_next_input';
    })[0];
  
    if (!setNextInput) {
      return;
    }
  
    const text = setNextInput.text as string;
    const replace = setNextInput.replace;
  
    if (replace) {
      cell.model.sharedModel.setSource(text);
      return;
    }
  
    // Create a new code cell and add as the next cell.
    const notebookModel = notebook.sharedModel;
    const cells = notebook.cells;
    const index = findIndex(cells, model => model === cell.model);
  
    // While this cell has no outputs and could be trusted following the letter
    // of Jupyter trust model, its content comes from kernel and hence is not
    // necessarily controlled by the user; if we set it as trusted, a user
    // executing cells in succession could end up with unwanted trusted output.
    if (index === -1) {
      notebookModel.insertCell(notebookModel.cells.length, {
        cell_type: 'code',
        source: text,
        metadata: {
          trusted: false
        }
      });
    } else {
      notebookModel.insertCell(index + 1, {
        cell_type: 'code',
        source: text,
        metadata: {
          trusted: false
        }
      });
    }
  }

