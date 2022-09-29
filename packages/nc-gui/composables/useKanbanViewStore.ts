import type { ComputedRef, Ref } from 'vue'
import type { Api, ColumnType, KanbanType, SelectOptionType, SelectOptionsType, TableType, ViewType } from 'nocodb-sdk'
import { useI18n } from 'vue-i18n'
import { message } from 'ant-design-vue'
import type { Row } from '~/lib'
import { SharedViewPasswordInj, deepCompare, enumColor, extractPkFromRow, useInjectionState, useNuxtApp } from '#imports'

type GroupingFieldColOptionsType = SelectOptionType & { collapsed: boolean }

const [useProvideKanbanViewStore, useKanbanViewStore] = useInjectionState(
  (
    meta: Ref<TableType | KanbanType | undefined>,
    viewMeta: Ref<ViewType | KanbanType | undefined> | ComputedRef<(ViewType & { id: string }) | undefined>,
    shared = false,
  ) => {
    if (!meta) {
      throw new Error('Table meta is not available')
    }

    const { t } = useI18n()

    const { api } = useApi()

    const { project } = useProject()

    const { $e, $api } = useNuxtApp()

    const { sorts, nestedFilters } = useSmartsheetStoreOrThrow()

    const { sharedView, fetchSharedViewData, fetchSharedViewGroupedData } = useSharedView()

    const { isUIAllowed } = useUIPermission()

    const isPublic = ref(shared) || inject(IsPublicInj, ref(false))

    const password = ref<string | null>(null)

    provide(SharedViewPasswordInj, password)

    // kanban view meta data
    const kanbanMetaData = ref<KanbanType>({})

    // grouping field column options - e.g. title, fk_column_id, color etc
    const groupingFieldColOptions = ref<GroupingFieldColOptionsType[]>([])

    // formattedData structure
    // {
    //   [val1] : [
    //     {row: {...}, oldRow: {...}, rowMeta: {...}},
    //     {row: {...}, oldRow: {...}, rowMeta: {...}},
    //     ...
    //   ],
    //   [val2] : [
    //     {row: {...}, oldRow: {...}, rowMeta: {...}},
    //     {row: {...}, oldRow: {...}, rowMeta: {...}},
    //     ...
    //   ],
    // }
    const formattedData = ref<Record<string, Row[]>>({})

    // countByStack structure
    // {
    //   "uncategorized": 0,
    //   [val1]: 10,
    //   [val2]: 20
    // }
    const countByStack = ref<Record<string, number>>({})

    // grouping field title
    const groupingField = ref<string>('')

    // grouping field column
    const groupingFieldColumn = ref<ColumnType | undefined>()

    // stack meta in object format
    const stackMetaObj = ref<Record<string, GroupingFieldColOptionsType[]>>({})

    const shouldScrollToRight = ref(false)

    const formatData = (list: Record<string, any>[]) =>
      list.map((row) => ({
        row: { ...row },
        oldRow: { ...row },
        rowMeta: {},
      }))

    async function loadKanbanData() {
      if ((!project?.value?.id || !meta.value?.id || !viewMeta?.value?.id) && !isPublic.value) return

      // reset formattedData & countByStack to avoid storing previous data after changing grouping field
      formattedData.value = {}
      countByStack.value = {}

      let res

      if (isPublic.value) {
        res = await fetchSharedViewGroupedData(groupingFieldColumn!.value!.id!)
      } else {
        res = await api.dbViewRow.groupedDataList(
          'noco',
          project.value.id!,
          meta.value!.id!,
          viewMeta.value!.id!,
          groupingFieldColumn!.value!.id!,
          {},
          {},
        )
      }

      for (const data of res) {
        const key = data.key === null ? 'uncategorized' : data.key
        formattedData.value[key] = formatData(data.value.list)
        countByStack.value[key] = data.value.pageInfo.totalRows || 0
      }
    }

    async function loadMoreKanbanData(stackTitle: string, params: Parameters<Api<any>['dbViewRow']['list']>[4] = {}) {
      if ((!project?.value?.id || !meta.value?.id || !viewMeta.value?.id) && !isPublic.value) return
      let where = `(${groupingField.value},eq,${stackTitle})`
      if (stackTitle === 'uncategorized') {
        where = `(${groupingField.value},is,null)`
      }
      const response = !isPublic.value
        ? await api.dbViewRow.list('noco', project.value.id!, meta.value!.id!, viewMeta.value!.id!, {
            ...params,
            ...(isUIAllowed('sortSync') ? {} : { sortArrJson: JSON.stringify(sorts.value) }),
            ...(isUIAllowed('filterSync') ? {} : { filterArrJson: JSON.stringify(nestedFilters.value) }),
            where,
          })
        : await fetchSharedViewData(params)

      formattedData.value[stackTitle] = [...formattedData.value[stackTitle], ...formatData(response.list)]
    }

    async function loadKanbanMeta() {
      if (!viewMeta?.value?.id || !meta?.value?.columns) return
      kanbanMetaData.value = isPublic.value
        ? (sharedView.value?.view as KanbanType)
        : await $api.dbView.kanbanRead(viewMeta.value.id)
      // set groupingField
      groupingFieldColumn.value =
        (meta.value.columns as ColumnType[]).filter((f) => f.id === kanbanMetaData.value.grp_column_id)[0] || {}

      groupingField.value = groupingFieldColumn.value.title!

      const { grp_column_id, meta: stack_meta } = kanbanMetaData.value

      stackMetaObj.value = stack_meta ? JSON.parse(stack_meta as string) : {}

      if (stackMetaObj.value && grp_column_id && stackMetaObj.value[grp_column_id]) {
        // keep the existing order (index of the array) but update the values done outside kanban
        let isChanged = false
        let hasNewOptionsAdded = false
        for (const option of (groupingFieldColumn.value.colOptions as SelectOptionsType)?.options ?? []) {
          const idx = stackMetaObj.value[grp_column_id].findIndex((ele) => ele.id === option.id)
          if (idx !== -1) {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { collapsed, ...rest } = stackMetaObj.value[grp_column_id][idx]
            if (!deepCompare(rest, option)) {
              // update the option in stackMetaObj
              stackMetaObj.value[grp_column_id][idx] = {
                ...stackMetaObj.value[grp_column_id][idx],
                ...option,
              }
              // rename the key in formattedData & countByStack
              if (option.title !== rest.title) {
                delete Object.assign(formattedData.value, { [option.title!]: formattedData.value[rest.title!] })[rest.title!]
                delete Object.assign(countByStack.value, { [option.title!]: countByStack.value[rest.title!] })[rest.title!]
                // update grouping field value under the edited stack
                await bulkUpdateGroupingFieldValue(option.title!)
              }
              isChanged = true
            }
          } else {
            // new option found - add to stackMetaObj
            stackMetaObj.value[grp_column_id].push({
              ...option,
              collapsed: false,
            })
            formattedData.value[option.title!] = []
            countByStack.value[option.title!] = 0
            isChanged = true
            hasNewOptionsAdded = true
          }
        }

        // handle deleted options
        const columnOptionIds = (groupingFieldColumn.value?.colOptions as SelectOptionsType)?.options.map(({ id }) => id)
        const cols = stackMetaObj.value[grp_column_id].filter(({ id }) => id !== 'uncategorized' && !columnOptionIds.includes(id))
        for (const col of cols) {
          const idx = stackMetaObj.value[grp_column_id].map((ele: Record<string, any>) => ele.id).indexOf(col.id)
          if (idx !== -1) {
            stackMetaObj.value[grp_column_id].splice(idx, 1)
            // there are two cases
            // 1. delete option from Add / Edit Stack in kanban view
            // 2. delete option from grid view, then switch to kanban view
            // for the second case, formattedData.value and countByStack.value would be empty at this moment
            // however, the data will be correct after rendering
            if (Object.keys(formattedData.value).length && Object.keys(countByStack.value).length) {
              // for the first case, no reload is executed.
              // hence, we set groupingField to null for all records under the target stack
              await bulkUpdateGroupingFieldValue(col.title!, true)
              // merge the to-be-deleted stack to uncategorized stack
              formattedData.value.uncategorized = [...formattedData.value.uncategorized, ...formattedData.value[col.title!]]
              // update the record count
              countByStack.value.uncategorized += countByStack.value[col.title!]
            }
            isChanged = true
          }
        }
        groupingFieldColOptions.value = stackMetaObj.value[grp_column_id]

        if (isChanged) {
          await updateKanbanStackMeta()
          if (hasNewOptionsAdded) {
            shouldScrollToRight.value = true
          }
        }
      } else {
        // build stack meta
        groupingFieldColOptions.value = [
          ...((groupingFieldColumn.value?.colOptions as SelectOptionsType & { collapsed: boolean })?.options ?? []),
          // enrich uncategorized stack
          { id: 'uncategorized', title: 'uncategorized', order: 0, color: enumColor.light[2] },
        ]
          // sort by initial order
          .sort((a, b) => a.order! - b.order!)
          // enrich `collapsed`
          .map((ele) => ({
            ...ele,
            collapsed: false,
          }))
        await updateKanbanStackMeta()
      }
    }

    async function updateKanbanStackMeta() {
      const { grp_column_id } = kanbanMetaData.value
      if (grp_column_id) {
        stackMetaObj.value[grp_column_id] = groupingFieldColOptions.value
        await updateKanbanMeta({
          meta: stackMetaObj.value,
        })
      }
    }

    async function updateKanbanMeta(updateObj: Partial<KanbanType>) {
      if (!viewMeta?.value?.id || !isUIAllowed('xcDatatableEditable')) return
      await $api.dbView.kanbanUpdate(viewMeta.value.id, {
        ...kanbanMetaData.value,
        ...updateObj,
      })
    }

    async function insertRow(row: Record<string, any>, rowIndex = formattedData.value.uncatgorized?.length) {
      try {
        const insertObj = (meta?.value?.columns as ColumnType[]).reduce((o: Record<string, any>, col) => {
          if (!col.ai && row?.[col.title as string] !== null) {
            o[col.title!] = row?.[col.title as string]
          }
          return o
        }, {})

        const insertedData = await $api.dbViewRow.create(
          NOCO,
          project?.value.id as string,
          meta.value?.id as string,
          viewMeta?.value?.id as string,
          insertObj,
        )

        formattedData.value.uncatgorized?.splice(rowIndex ?? 0, 1, {
          row: insertedData,
          rowMeta: {},
          oldRow: { ...insertedData },
        })

        return insertedData
      } catch (error: any) {
        message.error(await extractSdkResponseErrorMsg(error))
      }
    }

    async function updateRowProperty(toUpdate: Row, property: string) {
      try {
        const id = extractPkFromRow(toUpdate.row, meta?.value?.columns as ColumnType[])

        const updatedRowData = await $api.dbViewRow.update(
          NOCO,
          project?.value.id as string,
          meta.value?.id as string,
          viewMeta?.value?.id as string,
          id,
          {
            [property]: toUpdate.row[property],
          },
          // todo:
          // {
          //   query: { ignoreWebhook: !saved }
          // }
        )
        // audit
        $api.utils
          .auditRowUpdate(id, {
            fk_model_id: meta.value?.id as string,
            column_name: property,
            row_id: id,
            value: getHTMLEncodedText(toUpdate.row[property]),
            prev_value: getHTMLEncodedText(toUpdate.oldRow[property]),
          })
          .then(() => {})

        /** update row data(to sync formula and other related columns) */
        Object.assign(toUpdate.row, updatedRowData)
        Object.assign(toUpdate.oldRow, updatedRowData)
      } catch (e: any) {
        message.error(`${t('msg.error.rowUpdateFailed')} ${await extractSdkResponseErrorMsg(e)}`)
      }
    }

    async function updateOrSaveRow(row: Row) {
      if (row.rowMeta.new) {
        await insertRow(row.row, formattedData.value[row.row.title].indexOf(row))
      } else {
        await updateRowProperty(row, groupingField.value)
      }
    }

    async function bulkUpdateGroupingFieldValue(stackTitle: string, moveToUncategorizedStack = false) {
      try {
        // set groupingField to target value for all records under the target stack
        // if isTargetValueNull is true, then it means the cards under stackTitle will move to Uncategorized stack
        const groupingFieldVal = moveToUncategorizedStack ? null : stackTitle
        await api.dbTableRow.bulkUpdateAll(
          'noco',
          project.value.id!,
          meta.value?.id as string,
          {
            [groupingField.value]: groupingFieldVal,
          },
          {
            where: `(${groupingField.value},eq,${stackTitle})`,
          },
        )
        if (stackTitle in formattedData.value) {
          // update to groupingField value to target value
          formattedData.value[stackTitle] = formattedData.value[stackTitle].map((o) => ({
            ...o,
            row: {
              ...o.row,
              [groupingField.value]: groupingFieldVal,
            },
            oldRow: {
              ...o.oldRow,
              [groupingField.value]: o.row[groupingField.value],
            },
          }))
        }
      } catch (e: any) {
        message.error(await extractSdkResponseErrorMsg(e))
      }
    }

    async function deleteStack(stackTitle: string, stackIdx: number) {
      if (!viewMeta?.value?.id || !groupingFieldColumn.value) return
      try {
        // set groupingField to null for all records under the target stack
        await bulkUpdateGroupingFieldValue(stackTitle, true)
        // merge the to-be-deleted stack to uncategorized stack
        formattedData.value.uncategorized = [...formattedData.value.uncategorized, ...formattedData.value[stackTitle]]
        countByStack.value.uncategorized += countByStack.value[stackTitle]
        // clear state for the to-be-deleted stack
        delete formattedData.value[stackTitle]
        delete countByStack.value[stackTitle]
        // delete the stack, i.e. grouping field value
        const newOptions = (groupingFieldColumn.value.colOptions as SelectOptionsType).options.filter(
          (o) => o.title !== stackTitle,
        )
        ;(groupingFieldColumn.value.colOptions as SelectOptionsType).options = newOptions
        await api.dbTableColumn.update(groupingFieldColumn.value.id!, {
          ...groupingFieldColumn.value,
          colOptions: {
            options: newOptions,
          },
        } as any)

        // update kanban stack meta
        groupingFieldColOptions.value.splice(stackIdx, 1)
        stackMetaObj.value[kanbanMetaData.value.grp_column_id!] = groupingFieldColOptions.value
        await updateKanbanStackMeta()
        $e('a:kanban:delete-stack')
      } catch (e: any) {
        message.error(await extractSdkResponseErrorMsg(e))
      }
    }

    function addEmptyRow(addAfter = formattedData.value.uncategorized?.length) {
      formattedData.value.uncategorized.splice(addAfter, 0, {
        row: {},
        oldRow: {},
        rowMeta: { new: true },
      })
      return formattedData.value.uncategorized[addAfter]
    }

    function addOrEditStackRow(row: Row, isNewRow: boolean) {
      const stackTitle = row.row[groupingField.value] ?? 'uncategorized'
      const oldStackTitle = row.oldRow[groupingField.value] ?? 'uncategorized'

      if (isNewRow) {
        // add a new record
        if (stackTitle) {
          // push the row to target stack
          formattedData.value[stackTitle].push(row)
          // increase the current count in the target stack by 1
          countByStack.value[stackTitle] += 1
          // clear the one under uncategorized since we don't reload the view
          removeRowFromUncategorizedStack()
        } else {
          // data will be still in Uncategorized stack
          // no action is required
        }
      } else {
        // update existing record
        const targetPrimaryKey = extractPkFromRow(row.row, meta!.value!.columns as ColumnType[])
        const idxToUpdate = formattedData.value[stackTitle].findIndex(
          (ele) => extractPkFromRow(ele.row, meta!.value!.columns as ColumnType[]) === targetPrimaryKey,
        )
        if (idxToUpdate !== -1) {
          // update the row in formattedData
          formattedData.value[stackTitle][idxToUpdate] = row
        }
        if (stackTitle !== oldStackTitle) {
          // remove old row from countByStack & formattedData
          countByStack.value[oldStackTitle] -= 1
          formattedData.value[oldStackTitle].pop()
          // add new row to countByStack & formattedData
          countByStack.value[stackTitle] += 1
          formattedData.value[stackTitle].push(row)
        }
      }
    }

    function removeRowFromUncategorizedStack() {
      // remove the last record
      formattedData.value.uncategorized.pop()
      // decrease total count by 1
      countByStack.value.uncategorized -= 1
    }

    return {
      loadKanbanData,
      loadMoreKanbanData,
      loadKanbanMeta,
      updateKanbanMeta,
      kanbanMetaData,
      formattedData,
      countByStack,
      groupingField,
      groupingFieldColOptions,
      groupingFieldColumn,
      updateOrSaveRow,
      addEmptyRow,
      addOrEditStackRow,
      deleteStack,
      updateKanbanStackMeta,
      removeRowFromUncategorizedStack,
      shouldScrollToRight,
    }
  },
  'kanban-view-store',
)

export { useProvideKanbanViewStore }

export function useKanbanViewStoreOrThrow() {
  const kanbanViewStore = useKanbanViewStore()

  if (kanbanViewStore == null) throw new Error('Please call `useProvideKanbanViewStore` on the appropriate parent component')

  return kanbanViewStore
}
