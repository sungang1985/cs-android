/** English dictionary: exactly the keys and `{param}` placeholders of zh.ts (unit-tested). */
import type { Dictionary } from './i18n';
export const en: Dictionary = {
  // ── app ──
  'app.title': 'Shell', 'app.subtitle': 'CS-style mobile shooter', 'app.rotate': 'Rotate your phone', 'app.loading': 'Loading…', 'app.unsupported': 'WebGL2 is not supported on this device',
  'app.offline': 'Offline ready', 'app.update': 'Update available', 'app.updateApply': 'Tap to update', 'app.version': 'Version {version}',

  // ── main menu / mode select / pause ──
  'menu.play': 'Play', 'menu.training': 'Training', 'menu.settings': 'Settings', 'menu.stats': 'Stats', 'menu.continue': 'Continue', 'menu.mode': 'Select mode', 'menu.back': 'Back', 'menu.paused': 'Paused',
  'menu.resume': 'Resume', 'menu.drop': 'Drop weapon', 'menu.quit': 'Quit to menu', 'menu.rematch': 'Rematch', 'menu.menu': 'Main menu', 'menu.buy': 'Buy', 'menu.close': 'Close', 'menu.start': 'Start',
  'menu.changeMode': 'Change mode', 'menu.confirm': 'OK', 'menu.cancel': 'Cancel', 'menu.quitConfirm': 'Quit to the main menu? You can resume this match with “Continue”.',
  'menu.lang': '中 / EN', 'menu.difficulty': 'Difficulty', 'menu.team': 'Team', 'menu.teamRandom': 'Random', 'menu.teamSize': 'Team size', 'menu.roundsToWin': 'Rounds to win',
  'menu.vs': '{n}v{n}', 'menu.firstTo': 'First to {n}',
  'difficulty.easy': 'Easy', 'difficulty.normal': 'Normal', 'difficulty.hard': 'Hard',

  // ── modes, maps, teams, reasons ──
  'mode.defusal': 'Bomb Defusal', 'mode.tdm': 'Team Deathmatch', 'mode.training': 'Training',
  'mode.defusal.desc': '5v5 · ≈ 10 min · plant or defuse the bomb', 'mode.tdm.desc': '{minutes} min · first to {kills} kills · respawns', 'mode.training.desc': 'Static targets · practise moving, aiming and buying',
  'map.depot': 'Depot',
  'team.T': 'Terrorists', 'team.CT': 'Counter-Terrorists', 'team.T.short': 'T', 'team.CT.short': 'CT', 'team.own': 'Your team', 'team.enemy': 'Enemy',
  'reason.elimination': 'Enemy eliminated', 'reason.bomb': 'Bomb exploded', 'reason.defuse': 'Bomb defused', 'reason.time': 'Time ran out', 'reason.draw': 'Draw',

  // ── match end / round end ──
  'match.win': 'Victory', 'match.lose': 'Defeat', 'match.draw': 'Draw',
  'match.mvp': 'MVP', 'match.roundMvp': 'Round MVP: {name}', 'match.score': 'Score', 'match.finalScore': 'Final score {t} : {ct}',
  'match.kills': 'Kills', 'match.deaths': 'Deaths', 'match.kd': 'K/D', 'match.hs': 'HS %', 'match.accuracy': 'Accuracy', 'match.damage': 'Damage',
  'match.personal': 'Your stats', 'match.assist': 'Aim assist: {level}', 'match.rounds': '{n} rounds', 'match.moneyDeltas': 'Round income',

  // ── HUD ──
  'hud.roundWin': '{team} win', 'hud.roundDraw': 'Round draw', 'hud.bombPlanted': 'Bomb planted', 'hud.plant': 'Plant', 'hud.defuse': 'Defuse', 'hud.pickup': 'Pick up', 'hud.skip': 'Skip round',
  'hud.planting': 'Planting…', 'hud.defusing': 'Defusing…', 'hud.bombDefused': 'Bomb defused', 'hud.bombExploded': 'Bomb exploded', 'hud.bombDropped': 'The bomb was dropped', 'hud.bombPickedUp': 'You picked up the bomb', 'hud.youHaveBomb': 'You have the bomb',
  'hud.reloadNow': 'Reload!', 'hud.buyTime': 'Buy {time}', 'hud.spectating': 'Spectating: {name}', 'hud.killedBy': 'Killed by {name}', 'hud.headshot': 'Headshot', 'hud.you': 'You',
  'hud.round': 'Round {n}', 'hud.freeze': 'Get ready', 'hud.suddenDeath': 'Sudden death', 'hud.halftime': 'Switching sides', 'hud.lastRoundOfHalf': 'Last round of the half', 'hud.matchPoint': 'Match point',
  'hud.respawnIn': 'Respawn in {seconds} s', 'hud.spawnProtected': 'Spawn protection', 'hud.tdmTarget': 'First to {kills}', 'hud.notEnoughMoney': 'Not enough money', 'hud.bought': 'Bought {item}',
  'hud.jump': 'Jump', 'hud.crouch': 'Crouch', 'hud.switch': 'Switch', 'hud.reload': 'Reload', 'hud.grenade': 'Nade', 'hud.scope': 'Scope', 'hud.pause': 'Pause', 'hud.alive': '{n} alive',
  'hud.money': '$ {amount}', 'hud.moneyGain': '+${amount}', 'hud.moneyLoss': '−${amount}',

  // ── money reasons ──
  'money.kill': 'Kill reward', 'money.plant': 'Plant bonus', 'money.defuse': 'Defuse bonus', 'money.win': 'Round win', 'money.loss': 'Loss bonus', 'money.plantedLoss': 'Planted-bomb bonus', 'money.buy': 'Purchase', 'money.halfReset': 'Side switch reset',

  // ── buy menu ──
  'buy.title': 'Buy', 'buy.cat.pistols': 'Pistols', 'buy.cat.rifles': 'SMG & Rifles', 'buy.cat.gear': 'Sniper & Gear', 'buy.cat.grenades': 'Grenades',
  'buy.preset.full': 'Full', 'buy.preset.force': 'Force', 'buy.preset.awp': 'AWP', 'buy.preset.auto': 'Auto', 'buy.preset.rebuy': 'Rebuy',
  'buy.affordable': 'Affordable', 'buy.tooExpensive': 'Not enough money', 'buy.owned': 'Owned', 'buy.teamOnly': '{team} only', 'buy.upgrade': 'Helmet upgrade', 'buy.refill': 'Refill armor', 'buy.max': 'Max carried',
  'buy.price': '${price}', 'buy.free': 'Free', 'buy.close': 'Close ✕', 'buy.continuous': 'Keep open', 'buy.timeLeft': '{time} left', 'buy.money': 'Money ${amount}',
  'buy.error.money': 'Not enough money', 'buy.error.window': 'Buy time is over', 'buy.error.zone': 'Only in your spawn area', 'buy.error.owned': 'Already owned', 'buy.error.team': 'Not available to your team', 'buy.error.max': 'Carry limit reached',

  // ── scoreboard ──
  'scoreboard.title': 'Scoreboard', 'scoreboard.player': 'Player', 'scoreboard.kills': 'K', 'scoreboard.deaths': 'D', 'scoreboard.money': 'Money', 'scoreboard.alive': 'Alive', 'scoreboard.dead': 'Dead', 'scoreboard.mvp': 'MVP', 'scoreboard.round': 'Round {n}',

  // ── settings ──
  'settings.title': 'Settings', 'settings.tab.controls': 'Controls', 'settings.tab.graphics': 'Graphics', 'settings.tab.sound': 'Sound', 'settings.tab.other': 'Language & other',
  'settings.on': 'On', 'settings.off': 'Off',
  'settings.sens': 'Sensitivity', 'settings.sensScoped': 'Scoped sensitivity', 'settings.accel': 'Look acceleration',
  'settings.aimAssist': 'Aim assist', 'settings.aimAssist.0': 'Off', 'settings.aimAssist.1': 'Low', 'settings.aimAssist.2': 'Medium', 'settings.aimAssist.3': 'High',
  'settings.autoFire': 'Auto-fire', 'settings.tapToFire': 'Tap to fire', 'settings.doubleTapJump': 'Double-tap to jump', 'settings.twoFingerReload': 'Two-finger tap to reload', 'settings.recoilCrosshair': 'Recoil crosshair',
  'settings.gyro': 'Gyroscope', 'settings.gyro.off': 'Off', 'settings.gyro.drag': 'While dragging', 'settings.gyro.always': 'Always', 'settings.gyroSens': 'Gyro sensitivity',
  'settings.crouchMode': 'Crouch', 'settings.crouchMode.toggle': 'Toggle', 'settings.crouchMode.hold': 'Hold',
  'settings.autoReload': 'Auto-reload', 'settings.autoBuy': 'Auto-buy', 'settings.autoPickup': 'Auto pick-up', 'settings.scopeHold': 'Keep scope after shot',
  'settings.layout': 'Customise layout', 'settings.layoutReset': 'Reset', 'settings.layoutSave': 'Save', 'settings.layoutScale': 'Button size', 'settings.layoutOpacity': 'Button opacity', 'settings.leftHanded': 'Left-handed',
  'settings.quality': 'Quality', 'settings.quality.low': 'Low', 'settings.quality.medium': 'Medium', 'settings.quality.high': 'High', 'settings.quality.auto': 'Auto',
  'settings.fpsCap': 'Frame rate', 'settings.fpsCap.30': '30', 'settings.fpsCap.60': '60', 'settings.fpsCap.0': 'Unlimited', 'settings.batterySaver': 'Battery saver', 'settings.fov': 'Field of view',
  'settings.haptics': 'Vibration', 'settings.volume.master': 'Master volume', 'settings.volume.sfx': 'Effects', 'settings.volume.ui': 'Interface',
  'settings.language': 'Language', 'settings.language.zh': '中文', 'settings.language.en': 'English', 'settings.language.auto': 'System default',
  'settings.resetData': 'Reset data', 'settings.resetConfirm': 'Erase all settings, stats and the saved match?',

  // ── onboarding ──
  'onboarding.title': 'Tutorial', 'onboarding.step': 'Step {n}/{total}', 'onboarding.skip': 'Skip', 'onboarding.done': 'Done!', 'onboarding.finish': "Let's play",
  'onboarding.move': 'Move', 'onboarding.move.hint': 'Drag the joystick with your left thumb and walk to the marker',
  'onboarding.aim': 'Aim & fire', 'onboarding.aim.hint': 'Drag on the right half to aim, press Fire or tap the screen, and knock down {n} targets', 'onboarding.aim.progress': '{done}/{total} down',
  'onboarding.buy': 'Buy', 'onboarding.buy.hint': 'Tap “Buy” and get an AK-47 with “Full”',
  'onboarding.assist.title': 'Choose your aim assist', 'onboarding.assist.hint': 'You can change it later in Settings → Controls',

  // ── lifetime stats ──
  'stats.title': 'Stats', 'stats.matches': 'Matches', 'stats.wins': 'Wins', 'stats.draws': 'Draws', 'stats.kd': 'K/D', 'stats.hs': 'HS %', 'stats.favourite': 'Favourite weapon', 'stats.bestStreak': 'Best streak', 'stats.assist': 'Aim assist usage', 'stats.none': 'No data yet',

  // ── weapons & items ──
  'weapon.knife': 'Knife', 'weapon.glock': 'Glock-18', 'weapon.usp': 'USP-S', 'weapon.deagle': 'Desert Eagle', 'weapon.mp5': 'MP5-SD', 'weapon.ak47': 'AK-47', 'weapon.m4a4': 'M4A4', 'weapon.awp': 'AWP', 'weapon.he': 'HE Grenade', 'weapon.flash': 'Flashbang',
  'weapon.fall': 'Fall', 'weapon.bomb': 'C4 explosion',
  'item.kevlar': 'Kevlar', 'item.kevlar_helmet': 'Kevlar + Helmet', 'item.defuse_kit': 'Defuse kit', 'item.c4': 'C4',

  // ── map areas ──
  'area.t_spawn': 'T Spawn', 'area.t_north': 'North Room', 'area.t_south': 'South Room', 'area.long': 'Long', 'area.mid': 'Mid Yard', 'area.tunnel': 'Tunnel', 'area.ct_spawn': 'CT Spawn', 'area.site_a': 'A Site',
  'area.site_b': 'B Site', 'area.a_ramp': 'A Ramp', 'area.a_ramp_ct': 'A Back Ramp', 'area.mid_window': 'Mid Window', 'area.tunnel_window': 'Tunnel Window', 'area.a_connector': 'A Connector', 'area.b_connector': 'B Connector', 'area.b_door_ct': 'B Back Door',

  // ── bot names ──
  'bot.wang': 'Wang', 'bot.qiang': 'Qiang', 'bot.lei': 'Lei', 'bot.fang': 'Fang', 'bot.hu': 'Hu', 'bot.lin': 'Lin', 'bot.song': 'Song', 'bot.yu': 'Yu', 'bot.bao': 'Bao', 'bot.kai': 'Kai', 'bot.ming': 'Ming', 'bot.tao': 'Tao', 'bot.player': 'You',
};
