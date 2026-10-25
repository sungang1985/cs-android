/**
 * zh-CN dictionary — the source of truth (§11.13). en.ts must have exactly the same keys and the same `{param}`
 * placeholders (unit-tested). Key families owned here: weapon.* item.* area.* bot.* map.* mode.* reason.* team.*,
 * plus the HUD/menu/match/buy/settings/onboarding/stats copy of §7.6 and §8. UI-only extras live in zh.ui.ts (L8).
 */
import type { Dictionary } from './i18n';
export const zh: Dictionary = {
  // ── app ──
  'app.title': '弹壳', 'app.subtitle': 'CS 风格手机射击', 'app.rotate': '请横屏', 'app.loading': '加载中…', 'app.unsupported': '设备不支持 WebGL2',
  'app.offline': '离线可用', 'app.update': '有新版本', 'app.updateApply': '点击更新', 'app.version': '版本 {version}',

  // ── main menu / mode select / pause (§8.2, §8.3, §8.6) ──
  'menu.play': '开始游戏', 'menu.training': '训练场', 'menu.settings': '设置', 'menu.stats': '战绩', 'menu.continue': '继续上次比赛', 'menu.mode': '选择模式', 'menu.back': '返回', 'menu.paused': '暂停',
  'menu.resume': '继续', 'menu.drop': '丢弃武器', 'menu.quit': '退出到主菜单', 'menu.rematch': '再来一局', 'menu.menu': '主菜单', 'menu.buy': '购买', 'menu.close': '关闭', 'menu.start': '开始',
  'menu.changeMode': '换模式', 'menu.confirm': '确定', 'menu.cancel': '取消', 'menu.quitConfirm': '确定退出到主菜单？本局进度将保留在「继续上次比赛」。',
  'menu.lang': '中 / EN', 'menu.difficulty': '难度', 'menu.team': '阵营', 'menu.teamRandom': '随机', 'menu.teamSize': '人数', 'menu.roundsToWin': '获胜回合',
  'menu.vs': '{n}v{n}', 'menu.firstTo': '先胜 {n} 局',
  'difficulty.easy': '新手', 'difficulty.normal': '普通', 'difficulty.hard': '困难',

  // ── modes, maps, teams, reasons ──
  'mode.defusal': '爆破模式', 'mode.tdm': '团队死斗', 'mode.training': '训练场',
  'mode.defusal.desc': '5v5 · 约 10 分钟 · 安放或拆除炸弹', 'mode.tdm.desc': '{minutes} 分钟 · 先到 {kills} 杀 · 死亡后复活', 'mode.training.desc': '固定靶 · 练习移动、射击与购买',
  'map.depot': '货场',
  'team.T': '恐怖分子', 'team.CT': '反恐精英', 'team.T.short': 'T', 'team.CT.short': 'CT', 'team.own': '我方', 'team.enemy': '敌方',
  'reason.elimination': '全歼敌人', 'reason.bomb': '炸弹已爆炸', 'reason.defuse': '炸弹已拆除', 'reason.time': '时间耗尽', 'reason.draw': '平局',

  // ── match end / round end (§8.8) ──
  'match.win': '胜利', 'match.lose': '失败', 'match.draw': '平局',
  'match.mvp': 'MVP', 'match.roundMvp': '本回合 MVP：{name}', 'match.score': '比分', 'match.finalScore': '最终比分 {t} : {ct}',
  'match.kills': '击杀', 'match.deaths': '死亡', 'match.kd': 'K/D', 'match.hs': '爆头率', 'match.accuracy': '命中率', 'match.damage': '伤害',
  'match.personal': '个人数据', 'match.assist': '辅助瞄准：{level}', 'match.rounds': '{n} 回合', 'match.moneyDeltas': '本回合收入',

  // ── HUD (§8.1) ──
  'hud.roundWin': '{team} 获胜', 'hud.roundDraw': '平局', 'hud.bombPlanted': '炸弹已安放', 'hud.plant': '安放', 'hud.defuse': '拆除', 'hud.pickup': '拾取', 'hud.skip': '跳过回合',
  'hud.planting': '安放中…', 'hud.defusing': '拆除中…', 'hud.bombDefused': '炸弹已拆除', 'hud.bombExploded': '炸弹已爆炸', 'hud.bombDropped': '炸弹掉落了', 'hud.bombPickedUp': '你拾起了炸弹', 'hud.youHaveBomb': '你携带着炸弹',
  'hud.reloadNow': '换弹!', 'hud.buyTime': '购买 {time}', 'hud.spectating': '观战: {name}', 'hud.killedBy': '被 {name} 击杀', 'hud.headshot': '爆头', 'hud.you': '你',
  'hud.round': '第 {n} 回合', 'hud.freeze': '准备阶段', 'hud.suddenDeath': '决胜局', 'hud.halftime': '交换阵营', 'hud.lastRoundOfHalf': '上半场最后一回合', 'hud.matchPoint': '赛点',
  'hud.respawnIn': '{seconds} 秒后复活', 'hud.spawnProtected': '出生保护', 'hud.tdmTarget': '先到 {kills} 杀', 'hud.notEnoughMoney': '钱不够', 'hud.bought': '已购买 {item}',
  'hud.jump': '跳', 'hud.crouch': '蹲', 'hud.switch': '切枪', 'hud.reload': '换弹', 'hud.grenade': '雷', 'hud.scope': '开镜', 'hud.pause': '暂停', 'hud.alive': '存活 {n}',
  'hud.money': '$ {amount}', 'hud.moneyGain': '+${amount}', 'hud.moneyLoss': '−${amount}',

  // ── money reasons (round-end delta list) ──
  'money.kill': '击杀奖励', 'money.plant': '安放奖励', 'money.defuse': '拆除奖励', 'money.win': '回合胜利', 'money.loss': '失败补偿', 'money.plantedLoss': '安放补偿', 'money.buy': '购买', 'money.halfReset': '换边重置',

  // ── buy menu (§5.1, §8.4) ──
  'buy.title': '购买', 'buy.cat.pistols': '手枪', 'buy.cat.rifles': '冲锋枪 & 步枪', 'buy.cat.gear': '狙击 & 装备', 'buy.cat.grenades': '投掷物',
  'buy.preset.full': '全装', 'buy.preset.force': '半甲', 'buy.preset.awp': '狙击', 'buy.preset.auto': '自动', 'buy.preset.rebuy': '重买',
  'buy.affordable': '可负担', 'buy.tooExpensive': '钱不够', 'buy.owned': '已拥有', 'buy.teamOnly': '{team} 专用', 'buy.upgrade': '升级头盔', 'buy.refill': '补充护甲', 'buy.max': '已达上限',
  'buy.price': '${price}', 'buy.free': '免费', 'buy.close': '关闭 ✕', 'buy.continuous': '连续购买', 'buy.timeLeft': '剩余 {time}', 'buy.money': '金钱 ${amount}',
  'buy.error.money': '钱不够', 'buy.error.window': '购买时间已过', 'buy.error.zone': '只能在出生点购买', 'buy.error.owned': '已经拥有', 'buy.error.team': '本阵营不能购买', 'buy.error.max': '已达携带上限',

  // ── scoreboard (§8.7) ──
  'scoreboard.title': '计分板', 'scoreboard.player': '玩家', 'scoreboard.kills': '击杀', 'scoreboard.deaths': '死亡', 'scoreboard.money': '金钱', 'scoreboard.alive': '存活', 'scoreboard.dead': '阵亡', 'scoreboard.mvp': 'MVP', 'scoreboard.round': '第 {n} 回合',

  // ── settings (§8.5) ──
  'settings.title': '设置', 'settings.tab.controls': '控制', 'settings.tab.graphics': '画面', 'settings.tab.sound': '声音', 'settings.tab.other': '语言与其他',
  'settings.on': '开', 'settings.off': '关',
  'settings.sens': '灵敏度', 'settings.sensScoped': '开镜灵敏度', 'settings.accel': '灵敏度加速',
  'settings.aimAssist': '辅助瞄准', 'settings.aimAssist.0': '关', 'settings.aimAssist.1': '低', 'settings.aimAssist.2': '中', 'settings.aimAssist.3': '高',
  'settings.autoFire': '自动开火', 'settings.tapToFire': '点击开火', 'settings.doubleTapJump': '双击跳跃', 'settings.twoFingerReload': '双指换弹', 'settings.recoilCrosshair': '动态准星',
  'settings.gyro': '陀螺仪', 'settings.gyro.off': '关', 'settings.gyro.drag': '拖动时', 'settings.gyro.always': '始终', 'settings.gyroSens': '陀螺仪灵敏度',
  'settings.crouchMode': '蹲', 'settings.crouchMode.toggle': '切换', 'settings.crouchMode.hold': '按住',
  'settings.autoReload': '自动换弹', 'settings.autoBuy': '自动购买', 'settings.autoPickup': '自动拾取', 'settings.scopeHold': '开镜保持',
  'settings.layout': '自定义布局', 'settings.layoutReset': '重置', 'settings.layoutSave': '保存', 'settings.layoutScale': '按键大小', 'settings.layoutOpacity': '按键透明度', 'settings.leftHanded': '左手模式',
  'settings.quality': '画质', 'settings.quality.low': '低', 'settings.quality.medium': '中', 'settings.quality.high': '高', 'settings.quality.auto': '自动',
  'settings.fpsCap': '帧率', 'settings.fpsCap.30': '30', 'settings.fpsCap.60': '60', 'settings.fpsCap.0': '不限', 'settings.batterySaver': '省电模式', 'settings.fov': '视野 FOV',
  'settings.haptics': '震动', 'settings.volume.master': '主音量', 'settings.volume.sfx': '效果', 'settings.volume.ui': '界面',
  'settings.language': '语言', 'settings.language.zh': '中文', 'settings.language.en': 'English', 'settings.language.auto': '跟随系统',
  'settings.resetData': '重置数据', 'settings.resetConfirm': '确定清除所有设置、战绩和存档？',

  // ── onboarding (§7.6) ──
  'onboarding.title': '新手教学', 'onboarding.step': '第 {n}/{total} 步', 'onboarding.skip': '跳过', 'onboarding.done': '完成！', 'onboarding.finish': '开始游戏',
  'onboarding.move': '移动', 'onboarding.move.hint': '用左手拇指拖动摇杆，走到地上的标记处',
  'onboarding.aim': '瞄准与射击', 'onboarding.aim.hint': '在右半屏拖动瞄准，按开火键或轻点屏幕，击倒 {n} 个靶子', 'onboarding.aim.progress': '已击倒 {done}/{total}',
  'onboarding.buy': '购买', 'onboarding.buy.hint': '点「购买」，用「全装」买一把 AK-47',
  'onboarding.assist.title': '选择辅助瞄准强度', 'onboarding.assist.hint': '之后可以在 设置 → 控制 中修改',

  // ── lifetime stats (§8.8) ──
  'stats.title': '战绩', 'stats.matches': '比赛场数', 'stats.wins': '胜场', 'stats.draws': '平局', 'stats.kd': 'K/D', 'stats.hs': '爆头率', 'stats.favourite': '最爱武器', 'stats.bestStreak': '最佳连杀', 'stats.assist': '辅助瞄准使用', 'stats.none': '暂无数据',

  // ── weapons & items (§4.1) ──
  'weapon.knife': '匕首', 'weapon.glock': 'Glock-18', 'weapon.usp': 'USP-S', 'weapon.deagle': '沙漠之鹰', 'weapon.mp5': 'MP5-SD', 'weapon.ak47': 'AK-47', 'weapon.m4a4': 'M4A4', 'weapon.awp': 'AWP', 'weapon.he': '高爆手雷', 'weapon.flash': '闪光弹',
  'weapon.fall': '摔落', 'weapon.bomb': 'C4 爆炸',
  'item.kevlar': '防弹衣', 'item.kevlar_helmet': '防弹衣+头盔', 'item.defuse_kit': '拆弹器', 'item.c4': 'C4 炸弹',

  // ── map areas (§3.2) ──
  'area.t_spawn': 'T出生点', 'area.t_north': '北仓', 'area.t_south': '南仓', 'area.long': '长廊', 'area.mid': '中庭', 'area.tunnel': '隧道', 'area.ct_spawn': 'CT出生点', 'area.site_a': 'A点',
  'area.site_b': 'B点', 'area.a_ramp': 'A坡', 'area.a_ramp_ct': 'A后坡', 'area.mid_window': '天窗', 'area.tunnel_window': '地窗', 'area.a_connector': 'A连接', 'area.b_connector': 'B连接', 'area.b_door_ct': 'B后门',

  // ── bot names (§6.1) ──
  'bot.wang': '老王', 'bot.qiang': '阿强', 'bot.lei': '小雷', 'bot.fang': '阿芳', 'bot.hu': '虎哥', 'bot.lin': '小林', 'bot.song': '老宋', 'bot.yu': '阿宇', 'bot.bao': '阿宝', 'bot.kai': '小凯', 'bot.ming': '阿明', 'bot.tao': '小涛', 'bot.player': '你',
};
