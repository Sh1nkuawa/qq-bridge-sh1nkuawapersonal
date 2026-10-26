// 极简串行队列：保证同一时间只有一任务在跑，前一个失败也不影响后一个。
//
// 用途（2026-10-26）：qq_speak 的"合成 → 发中文 → 发语音"必须**一条一条来**，
// 否则多人同一天生日时，模型并行调用会让两条语音的"中文/语音"交叉。

export function createSerialQueue() {
  let tail = Promise.resolve();
  /**
   * @param {() => Promise<any>} task
   * @returns {Promise<any>} 该任务自己的结果（失败会 rejected，但队列继续）
   */
  return function enqueue(task) {
    const run = tail.then(() => task(), () => task());
    // 队列尾只关心"这段结束了"，不传递失败
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}
