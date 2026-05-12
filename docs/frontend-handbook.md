# 前端核心工程化与底层原理手册 (Frontend Handbook)

## 1. React Fiber 架构原理
React 16 引入了 Fiber 架构，其核心目标是解决深度 DOM 树渲染时阻塞主线程导致的掉帧卡顿问题。
- **时间切片 (Time Slicing)**：将原本同步的渲染过程拆分成多个小任务（Chunk）。React 会在浏览器空闲时间（利用 MessageChannel 模拟 `requestIdleCallback` 机制）执行这些任务。如果单次执行时间超过 5ms，React 会主动将主线程控制权交还给浏览器，保证用户交互和 CSS 动画的绝对流畅。
- **单链表结构**：Fiber 节点将原本的虚拟 DOM 树形结构转换成了单链表结构（包含 `child`、`sibling`、`return` 三个核心指针）。这种数据结构使得渲染过程可以随时被精确中断、暂停和恢复。
- **双缓存树 (Double Buffering)**：React 内存中同时存在两棵树：`current` 树（当前屏幕正在显示的）和 `workInProgress` 树（正在内存中异步构建的）。当更新计算完成后，React 只需要切换根节点的指针，即可瞬间完成视图更新。

## 2. 浏览器事件循环 (Event Loop) 核心执行机制
JavaScript 是单线程语言，必须依靠 Event Loop 机制来调度和处理异步任务。
- **宏任务 (Macrotask)**：包含 `setTimeout`、`setInterval`、网络请求回调、UI 渲染等。
- **微任务 (Microtask)**：包含 `Promise.then/.catch`、`MutationObserver`、`queueMicrotask`。
- **严格执行顺序**：
  1. 引擎执行全局同步代码，清空当前的调用栈。
  2. 检查微任务队列，**一次性清空**所有微任务（如果在清空过程中产生了新的微任务，也会在当前周期一并清空）。
  3. 浏览器判断是否需要进行 UI 渲染（通常随屏幕刷新率，如 16.6ms 一次）。
  4. 从宏任务队列中取出一个最老的宏任务执行。
  5. 重复上述步骤。

## 3. 闭包陷阱与内存泄漏排查
闭包允许内部函数持续访问其词法作用域内的外部变量。在实际工程中，极易引发严重问题：
- **经典场景：React Hooks 中的过期闭包 (Stale Closure)**。在 `useEffect`、`useCallback` 或 `setInterval` 回调中，如果依赖项数组（deps）未准确填写，内部函数捕获到的 state 永远是组件初次渲染或某次历史渲染时的旧值。
- **内存泄漏：未销毁的事件监听与定时器**。在单页应用 (SPA) 中，如果组件卸载时（如 `useEffect` 的 cleanup 函数中）未调用 `clearInterval` 或 `removeEventListener`，由于闭包对 DOM 元素或大型数据对象的隐式引用，导致浏览器的垃圾回收器 (GC) 永远无法释放这块内存，最终造成页面卡顿甚至崩溃。
**经典代码示例（React 过期闭包）：**
```javascript
function Counter() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      // 闭包陷阱：由于 deps 为空数组，内部函数捕获的 count 永远是初次渲染的 0
      console.log('当前 count:', count); 
    }, 1000);
    
    // 必须清理定时器，否则导致内存泄漏
    return () => clearInterval(timer);
  }, []); // 依赖项缺失

  return <button onClick={() => setCount(c => c + 1)}>加一</button>;
}