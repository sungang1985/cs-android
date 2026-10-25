/** UI-only English strings (L8); every key of zh.ui.ts (a unit test enforces parity and matching {params}). */
import type { Dictionary } from './i18n';

export const enUi: Dictionary = {
  'ui.app.title': 'Shell', 'ui.app.subtitle': 'CS-style mobile shooter',
  'ui.loading': 'Loading…',
  'ui.menu.play': 'Play', 'ui.menu.training': 'Training', 'ui.menu.settings': 'Settings', 'ui.menu.stats': 'Stats', 'ui.menu.continue': 'Continue', 'ui.menu.menu': 'Menu',
  'ui.main.offline': 'Offline ready', 'ui.main.newPlayer': 'New', 'ui.main.continueHint': 'Resume from the start of the round', 'ui.main.update': 'Update available', 'ui.main.updateNow': 'Update',
  'ui.common.back': 'Back', 'ui.common.on': 'On', 'ui.common.off': 'Off', 'ui.common.cancel': 'Cancel', 'ui.common.ok': 'OK',

  'ui.mode.title': 'Select mode', 'ui.mode.start': 'Start',
  'ui.mode.defusal': 'Defusal', 'ui.mode.defusal.desc': '5v5 · ≈ 10 min · plant / defuse the bomb',
  'ui.mode.tdm': 'Deathmatch', 'ui.mode.tdm.desc': 'Team deathmatch · 4 min · respawns',
  'ui.mode.training': 'Training', 'ui.mode.training.desc': 'Target range · tutorial',
  'ui.mode.difficulty': 'Difficulty', 'ui.mode.easy': 'Easy', 'ui.mode.normal': 'Normal', 'ui.mode.hard': 'Hard',
  'ui.mode.team': 'Team', 'ui.mode.random': 'Random', 'ui.mode.size': 'Size', 'ui.mode.rounds': 'Rounds', 'ui.mode.roundsN': 'First to {n}',

  'ui.pause.title': 'Paused', 'ui.pause.resume': 'Resume', 'ui.pause.buy': 'Buy', 'ui.pause.drop': 'Drop weapon', 'ui.pause.quit': 'Quit to menu', 'ui.pause.quitConfirm': 'Quit to the main menu? Progress is saved at the start of this round.',

  'ui.team.T': 'Terrorists', 'ui.team.CT': 'Counter-Terrorists',
  'ui.score.player': 'Player', 'ui.score.kills': 'K', 'ui.score.deaths': 'D', 'ui.score.money': 'Money',
  'ui.round.banner': '{team} win — {reason}', 'ui.round.draw': 'Draw — {reason}', 'ui.round.drawSub': 'Round drawn', 'ui.round.youWin': 'Your team won the round', 'ui.round.youLose': 'Your team lost the round', 'ui.round.mvp': 'MVP: {name}',
  'ui.money.kill': 'Kill', 'ui.money.plant': 'Plant', 'ui.money.defuse': 'Defuse', 'ui.money.win': 'Round win', 'ui.money.loss': 'Loss bonus', 'ui.money.plantedLoss': 'Loss bonus + plant', 'ui.money.buy': 'Purchase', 'ui.money.halfReset': 'Side swap',
  'ui.match.win': 'Victory', 'ui.match.lose': 'Defeat', 'ui.match.draw': 'Draw', 'ui.match.rematch': 'Rematch', 'ui.match.changeMode': 'Change mode', 'ui.match.assist': 'Aim assist: {level}',

  'ui.stats.title': 'Stats', 'ui.stats.matches': 'Matches', 'ui.stats.record': 'W / D / L', 'ui.stats.kd': 'K/D', 'ui.stats.hs': 'Headshots', 'ui.stats.accuracy': 'Accuracy', 'ui.stats.streak': 'Best streak', 'ui.stats.damage': 'Damage', 'ui.stats.favourite': 'Favourite weapon', 'ui.stats.assist': 'Aim assist used',
  'ui.assist.0': 'Off', 'ui.assist.1': 'Low', 'ui.assist.2': 'Medium', 'ui.assist.3': 'High',

  'ui.rotate.title': 'Rotate your phone', 'ui.rotate.hint': 'Turn your phone sideways to continue',

  'ui.settings.title': 'Settings', 'ui.settings.tab.controls': 'Controls', 'ui.settings.tab.graphics': 'Graphics', 'ui.settings.tab.audio': 'Audio', 'ui.settings.tab.other': 'Language & more',
  'ui.settings.sens': 'Sensitivity', 'ui.settings.sensScoped': 'Scoped sensitivity', 'ui.settings.accel': 'Look acceleration', 'ui.settings.aimAssist': 'Aim assist',
  'ui.settings.autoFire': 'Auto-fire', 'ui.settings.tapToFire': 'Tap to fire', 'ui.settings.doubleTapJump': 'Double-tap jump', 'ui.settings.twoFingerReload': 'Two-finger reload', 'ui.settings.recoilCrosshair': 'Recoil crosshair',
  'ui.settings.gyro': 'Gyroscope', 'ui.settings.gyro.off': 'Off', 'ui.settings.gyro.drag': 'While dragging', 'ui.settings.gyro.always': 'Always', 'ui.settings.gyroSens': 'Gyro sensitivity',
  'ui.settings.crouch': 'Crouch', 'ui.settings.crouch.toggle': 'Toggle', 'ui.settings.crouch.hold': 'Hold',
  'ui.settings.autoReload': 'Auto-reload', 'ui.settings.autoBuy': 'Auto-buy', 'ui.settings.autoPickup': 'Auto pick-up', 'ui.settings.scopeHold': 'Keep scope',
  'ui.settings.layout': 'Custom layout', 'ui.settings.layoutEdit': 'Edit', 'ui.settings.leftHanded': 'Left-handed',
  'ui.settings.quality': 'Quality', 'ui.settings.quality.low': 'Low', 'ui.settings.quality.medium': 'Medium', 'ui.settings.quality.high': 'High', 'ui.settings.quality.auto': 'Auto',
  'ui.settings.fps': 'Frame rate', 'ui.settings.fps.unlimited': 'Unlimited', 'ui.settings.batterySaver': 'Battery saver', 'ui.settings.fov': 'Field of view',
  'ui.settings.master': 'Master volume', 'ui.settings.sfx': 'Effects', 'ui.settings.uiVolume': 'Interface', 'ui.settings.haptics': 'Vibration',
  'ui.settings.language': 'Language', 'ui.settings.reset': 'Reset data', 'ui.settings.resetBtn': 'Reset', 'ui.settings.resetConfirm': 'Erase all settings, stats and saves? This cannot be undone.', 'ui.settings.version': 'Version',

  'ui.layout.scale': 'Scale', 'ui.layout.opacity': 'Opacity', 'ui.layout.reset': 'Reset', 'ui.layout.done': 'Done', 'ui.layout.hint': 'Drag a control to move it (snaps to 1 %)',
  'ui.layout.ctl.joystick': 'Stick', 'ui.layout.ctl.fireR': 'Fire', 'ui.layout.ctl.fireL': 'Fire', 'ui.layout.ctl.jump': 'Jump', 'ui.layout.ctl.crouch': 'Crouch', 'ui.layout.ctl.reload': 'Reload', 'ui.layout.ctl.switch': 'Switch',
  'ui.layout.ctl.scope': 'Scope', 'ui.layout.ctl.grenade': 'Nade', 'ui.layout.ctl.grenadeSelect': 'Swap', 'ui.layout.ctl.use': 'Plant/Defuse', 'ui.layout.ctl.buy': 'Buy', 'ui.layout.ctl.pause': 'Pause',

  'ui.onboarding.step': 'Step {n} of {total}', 'ui.onboarding.skip': 'Skip tutorial', 'ui.onboarding.stepDone': 'Done!',
  'ui.onboarding.move.title': 'Move', 'ui.onboarding.move.text': 'Drag the stick with your left thumb and walk to the glowing marker.',
  'ui.onboarding.aim.title': 'Aim & fire', 'ui.onboarding.aim.text': 'Drag on the right to aim; press Fire or tap to shoot. Hit 5 targets.', 'ui.onboarding.aim.progress': 'Hits {n} / {total}',
  'ui.onboarding.buy.title': 'Buy', 'ui.onboarding.buy.text': 'Tap Buy, then 「Full」 to buy a rifle.',
  'ui.onboarding.assist.title': 'Choose aim assist', 'ui.onboarding.assist.text': 'You can change it any time in Settings.',

  'ui.hud.buyWindow': 'Buy {time}', 'ui.hud.reload': 'Reload!', 'ui.hud.noAmmo': 'No ammo', 'ui.hud.planting': 'Planting…', 'ui.hud.defusing': 'Defusing…',
  'ui.hud.spectating': 'Spectating: {name}', 'ui.hud.spectatingNone': 'Spectating', 'ui.hud.killedBy': 'Killed by {name}', 'ui.hud.skip': 'Skip round ⏩',
  'ui.hud.bonus': '{amount}', 'ui.hud.bombPlanted': 'Bomb planted', 'ui.hud.bombDefused': 'Bomb defused', 'ui.hud.gotBomb': 'You have the C4', 'ui.hud.roundStart': 'Round {n}', 'ui.hud.go': 'Go!', 'ui.hud.suddenDeath': 'Sudden death',

  'ui.buy.title': 'Buy', 'ui.buy.close': 'Close ✕', 'ui.buy.continuous': 'Keep open', 'ui.buy.free': 'Free', 'ui.buy.unlimited': 'No time limit', 'ui.buy.timeLeft': '{time} left',
  'ui.buy.notInZone': 'Not in the buy zone', 'ui.buy.closed': 'Buy time is over', 'ui.buy.max': 'Full', 'ui.buy.noRebuy': 'Nothing yet', 'ui.buy.ownedAll': 'Owned', 'ui.buy.affordable': 'Affordable', 'ui.buy.poor': 'Not enough money',
  'ui.buy.preset.full': 'Full', 'ui.buy.preset.force': 'Force', 'ui.buy.preset.awp': 'AWP', 'ui.buy.preset.auto': 'Auto', 'ui.buy.preset.rebuy': 'Rebuy',
  'ui.buy.col.pistols': 'Pistols', 'ui.buy.col.rifles': 'SMG & Rifles', 'ui.buy.col.gear': 'Sniper & Gear', 'ui.buy.col.grenades': 'Grenades',
  'ui.buy.err.money': 'Not enough money', 'ui.buy.err.window': 'Buy time is over', 'ui.buy.err.zone': 'Not in the buy zone', 'ui.buy.err.owned': 'Already owned', 'ui.buy.err.team': 'Not available for your team', 'ui.buy.err.max': 'Carrying the maximum',
};
