/**
 * 浏览器半自己持有的文案：设置页里「决策模型」那一页的标题、字段名与说明。
 *
 * 页面上每一句都是给使用者看的：只说「按自己的需求该怎么设」与「改了会怎样」。字段名就是用户要填的
 * 那五项（名称、模型、API 地址、协议、API 密钥），不写本包的参数名、请求形状或内部机制；协议的两个
 * 取值是契约里的枚举本身，用户必须照着服务方给的接口类型选，所以照原样显示。
 *
 * @module
 */

/** 本命名空间的文案键。 */
export type SystemOneLocaleKey =
  | 'tab'
  | 'title'
  | 'intro'
  | 'reload'
  | 'empty'
  | 'add'
  | 'save'
  | 'saving'
  | 'saveFailed'
  | 'credentialFailed'
  | 'label'
  | 'labelHint'
  | 'kind'
  | 'kindHint'
  | 'baseUrl'
  | 'model'
  | 'modelPlaceholder'
  | 'key'
  | 'keyHint'
  | 'keyPlaceholder'
  | 'id'
  | 'idHint'
  | 'delete'

/** 中文文案。 */
export const zh: Record<SystemOneLocaleKey, string> = {
  tab: '决策模型',
  title: '决策模型条目',
  intro: '这里登记做判断的模型。名称只给人看，可以重名；协议按服务方给出的接口类型选；地址与模型名照服务方的文档填。',
  reload: '保存后要重载插件（或重启 DSH）才用得上新条目。',
  empty: '还没有条目。点下面的「新增条目」开始。',
  add: '新增条目',
  save: '保存',
  saving: '保存中…',
  saveFailed: '这次保存没有被接受，改动没有生效。',
  credentialFailed: '密钥没写进本机凭据，配置也没有改动。',
  label: '名称',
  labelHint: '只给人看，可以重名。',
  kind: '协议',
  kindHint: '与服务方给的接口类型一致，选错会在调用时报错。',
  baseUrl: 'API 地址',
  model: '模型',
  modelPlaceholder: '服务方文档里的模型名',
  key: 'API 密钥',
  keyHint: '只写进本机凭据，配置里只留一个引用名。留空表示这个条目不使用密钥；已经存过密钥时留空会保留原值。',
  keyPlaceholder: '留空＝不改',
  id: '条目 id',
  idHint: '保存后固定，复制给要用它的地方指名叫这个条目。',
  delete: '删除',
}

/** 英文文案。 */
export const en: Record<SystemOneLocaleKey, string> = {
  tab: 'Decision models',
  title: 'Decision model entries',
  intro: 'The models that make decisions. A name is for people only and may repeat; pick the protocol your provider documents; copy the address and model name from that provider.',
  reload: 'New entries take effect after reloading the plugin (or restarting DSH).',
  empty: 'No entries yet. Start with "Add entry" below.',
  add: 'Add entry',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'This save was not accepted; nothing changed.',
  credentialFailed: 'The key was not stored on this machine, and nothing was saved.',
  label: 'Name',
  labelHint: 'For people only; names may repeat.',
  kind: 'Protocol',
  kindHint: 'Match the interface type your provider documents; a wrong pick fails at call time.',
  baseUrl: 'API address',
  model: 'Model',
  modelPlaceholder: 'The model name from the provider docs',
  key: 'API key',
  keyHint: 'Stored on this machine only; the configuration keeps a reference name. Leave blank for no key, or to keep the key already stored.',
  keyPlaceholder: 'Blank = unchanged',
  id: 'Entry id',
  idHint: 'Fixed after saving; copy it wherever that entry is named.',
  delete: 'Delete',
}
