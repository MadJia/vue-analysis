/* @flow */

import type Watcher from './watcher'
import config from '../config'
import { callHook, activateChildComponent } from '../instance/lifecycle'

import {
  warn,
  nextTick,
  devtools,
  inBrowser,
  isIE
} from '../util/index'

export const MAX_UPDATE_COUNT = 100

const queue: Array<Watcher> = []
const activatedChildren: Array<Component> = []
let has: { [key: number]: ?true } = {}
let circular: { [key: number]: number } = {}
let waiting = false
let flushing = false
let index = 0

/**
 * Reset the scheduler's state.
 */
function resetSchedulerState () {
  index = queue.length = activatedChildren.length = 0
  has = {}
  if (process.env.NODE_ENV !== 'production') {
    circular = {}
  }
  waiting = flushing = false
}

// Async edge case #6566 requires saving the timestamp when event listeners are
// attached. However, calling performance.now() has a perf overhead especially
// if the page has thousands of event listeners. Instead, we take a timestamp
// every time the scheduler flushes and use that for all event listeners
// attached during that flush.
export let currentFlushTimestamp = 0

// Async edge case fix requires storing an event listener's attach timestamp.
let getNow: () => number = Date.now

// Determine what event timestamp the browser is using. Annoyingly, the
// timestamp can either be hi-res (relative to page load) or low-res
// (relative to UNIX epoch), so in order to compare time we have to use the
// same timestamp type when saving the flush timestamp.
// All IE versions use low-res event timestamps, and have problematic clock
// implementations (#9632)
if (inBrowser && !isIE) {
  const performance = window.performance
  if (
    performance &&
    typeof performance.now === 'function' &&
    getNow() > document.createEvent('Event').timeStamp
  ) {
    // if the event timestamp, although evaluated AFTER the Date.now(), is
    // smaller than it, it means the event is using a hi-res timestamp,
    // and we need to use the hi-res version for event listener timestamps as
    // well.
    getNow = () => performance.now()
  }
}

/**
 * Flush both queues and run the watchers.
 */
function flushSchedulerQueue () {
  currentFlushTimestamp = getNow()
  // 标记当前我们正在处理队列
  flushing = true
  let watcher, id

  // Sort queue before flush.
  // This ensures that:
  // 排序目的
  // 1. Components are updated from parent to child. (because parent is always
  //    created before the child)
  // 组件被更新的顺序是从父组件到子组件（因为我们先创建父组件后创建子组件）
  // 2. A component's user watchers are run before its render watcher (because
  //    user watchers are created before the render watcher)
  // 组件的用户watcher要在它对应的渲染watcher之前运行（因为用户watcher是在渲染
  // watcher之前创建的）
  // 3. If a component is destroyed during a parent component's watcher run,
  //    its watchers can be skipped.
  // 如果一个组件在它父组件执行之前被销毁了，那这个watcher应该被跳过
  queue.sort((a, b) => a.id - b.id)

  // do not cache length because more watchers might be pushed
  // as we run existing watchers
  // 不要去缓存length，因为当我们这些watcher在执行过程中，我们还有可能去给这个队列里面
  // 放入新的watcher
  for (index = 0; index < queue.length; index++) {
    watcher = queue[index]
    // 判断 watcher 是否有 before 函数，before 函数是我们在创建渲染watcher的时候才有
    // before 这个函数是用来触发钩子函数 beforeUpdate
    if (watcher.before) {
      watcher.before()
    }
    id = watcher.id
    has[id] = null
    // 调用 watcher 的 run 方法
    watcher.run()
    // in dev build, check and stop circular updates.
    if (process.env.NODE_ENV !== 'production' && has[id] != null) {
      circular[id] = (circular[id] || 0) + 1
      if (circular[id] > MAX_UPDATE_COUNT) {
        warn(
          'You may have an infinite update loop ' + (
            watcher.user
              ? `in watcher with expression "${watcher.expression}"`
              : `in a component render function.`
          ),
          watcher.vm
        )
        break
      }
    }
  }

  // keep copies of post queues before resetting state
  const activatedQueue = activatedChildren.slice()
  const updatedQueue = queue.slice()

  resetSchedulerState()

  // call component updated and activated hooks
  callActivatedHooks(activatedQueue)
  callUpdatedHooks(updatedQueue)

  // devtool hook
  /* istanbul ignore if */
  if (devtools && config.devtools) {
    devtools.emit('flush')
  }
}

function callUpdatedHooks (queue) {
  let i = queue.length
  while (i--) {
    const watcher = queue[i]
    const vm = watcher.vm
    if (vm._watcher === watcher && vm._isMounted && !vm._isDestroyed) {
      callHook(vm, 'updated')
    }
  }
}

/**
 * Queue a kept-alive component that was activated during patch.
 * The queue will be processed after the entire tree has been patched.
 */
export function queueActivatedComponent (vm: Component) {
  // setting _inactive to false here so that a render function can
  // rely on checking whether it's in an inactive tree (e.g. router-view)
  vm._inactive = false
  activatedChildren.push(vm)
}

function callActivatedHooks (queue) {
  for (let i = 0; i < queue.length; i++) {
    queue[i]._inactive = true
    activateChildComponent(queue[i], true /* true */)
  }
}

/**
 * Push a watcher into the watcher queue.
 * Jobs with duplicate IDs will be skipped unless it's
 * pushed when the queue is being flushed.
 */
export function queueWatcher (watcher: Watcher) {
  const id = watcher.id
  // 判断当前 watcher 是否已经被处理过了，防止 watcher 重复处理
  if (has[id] == null) {
    has[id] = true
    // flushing 为 true 表示当前队列正在处理
    if (!flushing) {
      // 如果当前队列没有被处理时，直接把 watcher 放到队列的末尾
      queue.push(watcher)
    } else {
      // 否则当前我们这个 queue 队列正在被处理
      // 这个时候就要找一个合适的位置把这个 watcher 放到 queue 里面来
      // if already flushing, splice the watcher based on its id
      // if already past its id, it will be run next immediately.
      let i = queue.length - 1
      // index：是当前这个队列处理到第几个元素
      // 如果 i 大于 index 说明这个队列还没有处理完
      // 接下来就从后往前取这个队列中每一个watcher对象的id是否大于watcher的id
      // 如果大于我们这个处理的watcher的id，这个位置就是我们要出入watcher的位置
      while (i > index && queue[i].id > watcher.id) {
        i--
      }
      // 插入到合适的位置
      queue.splice(i + 1, 0, watcher)
    }
    // queue the flush
    // 判断当前队列是否正在被执行，如果为 false 说明当前队列没有在执行
    if (!waiting) {
      waiting = true

      // 如果是开发环境
      if (process.env.NODE_ENV !== 'production' && !config.async) {
        // flushSchedulerQueue会遍历队列中的所有watcher，并且调用watcher的run方法
        flushSchedulerQueue()
        return
      }
      // nextTick 最终会调用 flushSchedulerQueue
      nextTick(flushSchedulerQueue)
    }
  }
}
