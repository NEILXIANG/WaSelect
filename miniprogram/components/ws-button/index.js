/**
 * 职责：按钮组件（F14 六个基础组件之一）——把"连点"这道防线收进组件里。
 *
 * @why 骨架页 `pages/index/index.js` 里有一行手写守卫 `if (this.data.loading) return;`，
 *      旁边写着原因：**微信的 `loading` 只显示转圈，不阻止 `bindtap`**，
 *      只有 `disabled` 才会真正挡住点击。于是"按钮正在处理中还能再点一次"
 *      这件事要**每个页面各自记得**——漏一个就是两条并发请求。
 *      收进组件之后，这条规则只有一处，页面不用再记。
 *
 * @why 只做这一个判断，不做"节流"（多少毫秒内只响应一次）：
 *      节流会把"用户真的想再点一次"也吃掉，而正确的重试时机由**业务**决定
 *      （建单失败后用户立刻重试是合理的）。这里只挡"上一次还没回来"这一种，
 *      那是纯粹的重复提交，没有任何业务含义。
 *
 * @limitation 一：**必须用 `catchtap` 而不是 `bindtap`**——这是实测出来的，不是风格偏好。
 *              用 `bindtap` 时，内部 `<button>` 的原生 tap 会**继续冒出组件**，
 *              于是"loading 时吞掉点击"根本不成立：组件里 return 了，页面却还是收到一次 tap
 *              （实测：loading=true 点一下，页面仍收到 1 次）。`catch` 会在组件内截住它，
 *              之后**只有** `triggerEvent` 那一个事件能出去。
 * @limitation 二：`disabled` 的拦截**依赖真机基础库**（原生 `disabled` 不触发 tap），
 *              simulate **模拟不了**它（内置 `wx-button` 连 `disabled` 属性都不渲染），
 *              所以那条性质只能在真机/样板页上验（L4）；组件测试里改为断言
 *              "wxml 确实把 `disabled` 接到了原生 button 上"（删了它按钮就永不禁用，且不报错）。
 *              两者不重复：`loading` 走 JS 守卫，`disabled` 走原生，缺一都会漏。
 * @limitation 三：`loading` 期间被吞掉的点击**不通知页面**（既不 emit 也不报错）。
 *              @why 通知了也没有正确的处理动作——页面能做的只有"忽略"，那和吞掉一样；
 *              而一旦有人拿它去弹提示，就会出现"用户正常等待时被提示点了没用"。
 * @limitation 四：文案只走 `text` 属性，**不用 slot**。
 *              @why slot 会让"按钮里能不能放图标"变成每个页面各试各的，
 *              而 MVP 的按钮就是一行字；真要放图标时再加，加的时候是**新增**不是改。
 * @limitation 五：`type` 只有 `primary / default` 两档，且非法档位**不静默回退**
 *              （与 ws-price 同一原则）：`type` 直接插 class 名时，传 `xl` 的表现是
 *              "没有任何档位样式命中 → 悄悄落回基础样式"，按钮长得不对且不报错。
 *              所以 class 走内部计算的 `typeClass`，非法值与 ws-price 非法档位同一条路：
 *              渲染空白 + 控制台明确报错（safeCallback 捕获，不冒泡给页面）。
 *
 * @see ../ws-price/index.js（同组组件，同样的"口径收一处"思路）；docs/地基搭建清单.md F14
 */
/** 类型档位全集（@see 文件头 @limitation 五）。 */
const TYPES = ['primary', 'default'];

/**
 * 校验类型档位。
 * @why 非法档位直接插 class 名会**静默**落回基础样式（没有该档位的样式命中）——
 *      看起来是个按钮，实际样式错了，且不报错。
 * @throws 档位不在 TYPES 里时原样抛出（走 safeCallback → 空白 + 控制台报错，不兜底）
 */
function assertType(type) {
  if (!TYPES.includes(type)) {
    throw new Error(`ws-button 的 type 必须是 ${TYPES.join(' / ')} 之一，收到：${String(type)}`);
  }
}

Component({
  properties: {
    /** 按钮文案。@see @limitation 四 */
    text: { type: String, value: '' },
    /** `primary` / `default`。@see @limitation 五 */
    type: { type: String, value: 'primary' },
    /** 处理中：显示转圈，并**吞掉点击**（@see 文件头 @why） */
    loading: { type: Boolean, value: false },
    /** 禁用：由原生 button 挡住点击。@see @limitation 二 */
    disabled: { type: Boolean, value: false },
  },

  data: {
    /** 档位 class（内部计算，非法档位到不了这里——@see assertType）。 */
    typeClass: 'ws-button--primary',
  },

  // ⚠️ `attached` 与 `observers` 都要调：`observers` 只在**属性变化**时触发，
  //    初始就传了非法值时（没有"变化"），只剩 `attached` 能让它响亮失败（与 ws-price 同理）。
  attached() {
    assertType(this.data.type);
  },
  observers: {
    type(type) {
      assertType(type);
      this.setData({ typeClass: `ws-button--${type}` });
    },
  },

  methods: {
    /**
     * 内部按钮的 tap。
     * @param {WechatMiniprogram.TouchEvent} e
     */
    onTap() {
      // ⚠️ 只在这里挡 `loading`：`disabled` 由原生 button 自己挡（它真的不触发 tap）。
      //    官方的 `loading` **只显示转圈、不阻止点击**——少了这一行，
      //    用户连点就会发出两条并发请求（页面里的手写守卫就是在补这个洞）。
      if (this.data.loading) return;

      // ⚠️ 不带 detail：这个组件没有"用户点了哪里"之类的附加信息可给，
      //    把原生事件的 detail（坐标等）透传出去反而会让页面以为有内容可看。
      this.triggerEvent('tap');
    },
  },
});
