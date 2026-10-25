/** UI-only zh-CN strings (L8). Display names of weapons/items/bots/reasons stay in L4's zh.ts (weapon.*, item.*, bot.*, reason.*). */
import type { Dictionary } from './i18n';

export const zhUi: Dictionary = {
  'ui.app.title': '弹壳', 'ui.app.subtitle': 'CS 风格手机射击',
  'ui.loading': '加载中…',
  'ui.menu.play': '开始游戏', 'ui.menu.training': '训练场', 'ui.menu.settings': '设置', 'ui.menu.stats': '战绩', 'ui.menu.continue': '继续上次比赛', 'ui.menu.menu': '主菜单',
  'ui.main.offline': '离线可用', 'ui.main.newPlayer': '新手', 'ui.main.continueHint': '从本回合开始继续', 'ui.main.update': '有新版本', 'ui.main.updateNow': '更新',
  'ui.common.back': '返回', 'ui.common.on': '开', 'ui.common.off': '关', 'ui.common.cancel': '取消', 'ui.common.ok': '确定',

  'ui.mode.title': '选择模式', 'ui.mode.start': '开始',
  'ui.mode.defusal': '爆破', 'ui.mode.defusal.desc': '5v5 · 约 10 分钟 · 安放 / 拆除炸弹',
  'ui.mode.tdm': '死斗', 'ui.mode.tdm.desc': '团队死斗 · 4 分钟 · 无限复活',
  'ui.mode.training': '训练', 'ui.mode.training.desc': '靶场练习 · 新手引导',
  'ui.mode.difficulty': '难度', 'ui.mode.easy': '新手', 'ui.mode.normal': '普通', 'ui.mode.hard': '困难',
  'ui.mode.team': '阵营', 'ui.mode.random': '随机', 'ui.mode.size': '人数', 'ui.mode.rounds': '回合', 'ui.mode.roundsN': '先赢 {n}',

  'ui.pause.title': '暂停', 'ui.pause.resume': '继续', 'ui.pause.buy': '购买', 'ui.pause.drop': '丢弃武器', 'ui.pause.quit': '退出到主菜单', 'ui.pause.quitConfirm': '退出到主菜单？比赛进度会保存在本回合开始时。',

  'ui.team.T': '恐怖分子', 'ui.team.CT': '反恐精英',
  'ui.score.player': '玩家', 'ui.score.kills': '击杀', 'ui.score.deaths': '死亡', 'ui.score.money': '金钱',
  'ui.round.banner': '{team} 胜利 — {reason}', 'ui.round.draw': '平局 — {reason}', 'ui.round.drawSub': '本回合平局', 'ui.round.youWin': '我方赢下本回合', 'ui.round.youLose': '我方输掉本回合', 'ui.round.mvp': 'MVP：{name}',
  'ui.money.kill': '击杀', 'ui.money.plant': '安放', 'ui.money.defuse': '拆除', 'ui.money.win': '回合胜利', 'ui.money.loss': '失败补偿', 'ui.money.plantedLoss': '失败补偿 + 安放', 'ui.money.buy': '购买', 'ui.money.halfReset': '换边',
  'ui.match.win': '胜利', 'ui.match.lose': '失败', 'ui.match.draw': '平局', 'ui.match.rematch': '再来一局', 'ui.match.changeMode': '换模式', 'ui.match.assist': '辅助瞄准：{level}',

  'ui.stats.title': '战绩', 'ui.stats.matches': '比赛', 'ui.stats.record': '胜 / 平 / 负', 'ui.stats.kd': 'K/D', 'ui.stats.hs': '爆头率', 'ui.stats.accuracy': '命中率', 'ui.stats.streak': '最高连杀', 'ui.stats.damage': '伤害', 'ui.stats.favourite': '最爱武器', 'ui.stats.assist': '辅助瞄准使用',
  'ui.assist.0': '关', 'ui.assist.1': '低', 'ui.assist.2': '中', 'ui.assist.3': '高',

  'ui.rotate.title': '请横屏', 'ui.rotate.hint': '把手机横过来即可继续',

  'ui.settings.title': '设置', 'ui.settings.tab.controls': '控制', 'ui.settings.tab.graphics': '画面', 'ui.settings.tab.audio': '声音', 'ui.settings.tab.other': '语言与其他',
  'ui.settings.sens': '灵敏度', 'ui.settings.sensScoped': '开镜灵敏度', 'ui.settings.accel': '灵敏度加速', 'ui.settings.aimAssist': '辅助瞄准',
  'ui.settings.autoFire': '自动开火', 'ui.settings.tapToFire': '点击开火', 'ui.settings.doubleTapJump': '双击跳跃', 'ui.settings.twoFingerReload': '双指换弹', 'ui.settings.recoilCrosshair': '动态准星',
  'ui.settings.gyro': '陀螺仪', 'ui.settings.gyro.off': '关', 'ui.settings.gyro.drag': '拖动时', 'ui.settings.gyro.always': '始终', 'ui.settings.gyroSens': '陀螺仪灵敏度',
  'ui.settings.crouch': '蹲', 'ui.settings.crouch.toggle': '切换', 'ui.settings.crouch.hold': '按住',
  'ui.settings.autoReload': '自动换弹', 'ui.settings.autoBuy': '自动购买', 'ui.settings.autoPickup': '自动拾取', 'ui.settings.scopeHold': '开镜保持',
  'ui.settings.layout': '自定义布局', 'ui.settings.layoutEdit': '编辑', 'ui.settings.leftHanded': '左手模式',
  'ui.settings.quality': '画质', 'ui.settings.quality.low': '低', 'ui.settings.quality.medium': '中', 'ui.settings.quality.high': '高', 'ui.settings.quality.auto': '自动',
  'ui.settings.fps': '帧率', 'ui.settings.fps.unlimited': '不限', 'ui.settings.batterySaver': '省电模式', 'ui.settings.fov': '视野 FOV',
  'ui.settings.master': '主音量', 'ui.settings.sfx': '效果', 'ui.settings.uiVolume': '界面', 'ui.settings.haptics': '震动',
  'ui.settings.language': '语言', 'ui.settings.reset': '重置数据', 'ui.settings.resetBtn': '重置', 'ui.settings.resetConfirm': '清除所有设置、战绩和存档？此操作无法撤销。', 'ui.settings.version': '版本',

  'ui.layout.scale': '缩放', 'ui.layout.opacity': '不透明度', 'ui.layout.reset': '重置', 'ui.layout.done': '完成', 'ui.layout.hint': '拖动按钮调整位置（1% 对齐）',
  'ui.layout.ctl.joystick': '摇杆', 'ui.layout.ctl.fireR': '开火', 'ui.layout.ctl.fireL': '开火', 'ui.layout.ctl.jump': '跳', 'ui.layout.ctl.crouch': '蹲', 'ui.layout.ctl.reload': '换弹', 'ui.layout.ctl.switch': '切枪',
  'ui.layout.ctl.scope': '开镜', 'ui.layout.ctl.grenade': '雷', 'ui.layout.ctl.grenadeSelect': '切雷', 'ui.layout.ctl.use': '安放/拆除', 'ui.layout.ctl.buy': '购买', 'ui.layout.ctl.pause': '暂停',

  'ui.onboarding.step': '第 {n} 步 / 共 {total} 步', 'ui.onboarding.skip': '跳过引导', 'ui.onboarding.stepDone': '完成！',
  'ui.onboarding.move.title': '移动', 'ui.onboarding.move.text': '左手拖动摇杆，走到发光的标记处。',
  'ui.onboarding.aim.title': '瞄准与射击', 'ui.onboarding.aim.text': '右手拖动瞄准，按开火键或轻点屏幕射击，击中 5 个靶子。', 'ui.onboarding.aim.progress': '已命中 {n} / {total}',
  'ui.onboarding.buy.title': '购买', 'ui.onboarding.buy.text': '点「购买」，再点「全装」买一把步枪。',
  'ui.onboarding.assist.title': '选择辅助瞄准', 'ui.onboarding.assist.text': '之后可以在设置里随时修改。',

  'ui.hud.buyWindow': '购买 {time}', 'ui.hud.reload': '换弹!', 'ui.hud.noAmmo': '没子弹', 'ui.hud.planting': '安放中…', 'ui.hud.defusing': '拆除中…',
  'ui.hud.spectating': '观战: {name}', 'ui.hud.spectatingNone': '观战', 'ui.hud.killedBy': '被 {name} 击杀', 'ui.hud.skip': '跳过回合 ⏩',
  'ui.hud.bonus': '{amount}', 'ui.hud.bombPlanted': '炸弹已安放', 'ui.hud.bombDefused': '炸弹已拆除', 'ui.hud.gotBomb': '你拿到了 C4', 'ui.hud.roundStart': '第 {n} 回合', 'ui.hud.go': '行动！', 'ui.hud.suddenDeath': '决胜局',

  'ui.buy.title': '购买', 'ui.buy.close': '关闭 ✕', 'ui.buy.continuous': '连续购买', 'ui.buy.free': '免费', 'ui.buy.unlimited': '不限时', 'ui.buy.timeLeft': '剩余 {time}',
  'ui.buy.notInZone': '不在购买区域', 'ui.buy.closed': '购买时间已过', 'ui.buy.max': '已满', 'ui.buy.noRebuy': '无记录', 'ui.buy.ownedAll': '已拥有', 'ui.buy.affordable': '可负担', 'ui.buy.poor': '钱不够',
  'ui.buy.preset.full': '全装', 'ui.buy.preset.force': '半甲', 'ui.buy.preset.awp': '狙击', 'ui.buy.preset.auto': '自动', 'ui.buy.preset.rebuy': '重买',
  'ui.buy.col.pistols': '手枪', 'ui.buy.col.rifles': '冲锋枪 & 步枪', 'ui.buy.col.gear': '狙击 & 装备', 'ui.buy.col.grenades': '投掷物',
  'ui.buy.err.money': '钱不够', 'ui.buy.err.window': '购买时间已过', 'ui.buy.err.zone': '不在购买区域', 'ui.buy.err.owned': '已拥有', 'ui.buy.err.team': '该阵营不能购买', 'ui.buy.err.max': '已达携带上限',
};
