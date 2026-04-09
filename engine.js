// engine.js
export class SlotEngine {
    constructor(config, callbacks) {
        this.config = config;
        this.callbacks = callbacks || {}; 
        
        this.state = {
            credit: 100000,
            bet: 100,
            currentWin: 0,
            isFreeGame: false,
            freeSpinsLeft: 0,
            isSpinning: false,
            gridData: [],
            
            // ★ 新增：Hold & Win 專用狀態
            isHoldAndWin: false,
            respinLeft: 0,
            lockedCoins: {}, // 記錄被鎖定的金幣，格式如 {'c,r': 數值} (例如 {'0,2': 5, '1,1': 'MINI'})
            currentCoinValues: {},
        };

        this.poolBase = [];
        this.totalWeightBase = 0;
        this.initBasePool();
    }

    initBasePool() {
        this.poolBase = [];
        this.totalWeightBase = 0;
        for (let id in this.config.symbols) {
            let s = this.config.symbols[id];
            if (s.weightBase && s.weightBase > 0) {
                this.poolBase.push({ id: parseInt(id), weight: s.weightBase });
                this.totalWeightBase += s.weightBase;
            }
        }
    }

    getWeightedSymbol() {
        let r = Math.random() * this.totalWeightBase; 
        let sum = 0;
        for (let item of this.poolBase) { 
            sum += item.weight; 
            if (r <= sum) return item.id; 
        }
        return 9; 
    }

    // ★ 產生隨機金幣數值 (倍數 或 彩金字串)
    getRandomCoinValue() {
        let r = Math.random();
        if (r < 0.005) return 'MAJOR';  // 0.5% 機率出 MAJOR
        if (r < 0.02)  return 'MINOR';  // 1.5% 機率出 MINOR
        if (r < 0.10)  return 'MINI';   // 8.0% 機率出 MINI
        if (r < 0.30)  return 10;       // 10倍押注
        if (r < 0.60)  return 5;        // 5倍押注
        if (r < 0.85)  return 2;        // 2倍押注
        return 1;                       // 1倍押注
    }

    generateRandomGrid(isBuyFeature = false) {
        let newGrid = [];
        const { cols, rows } = this.config.mechanics;
        
        // ★ 購買特色時，強制塞入 6 顆金幣來觸發 Hold & Win
        let forcedCoinCoords = [];
        if (isBuyFeature) {
            let allCoords = [];
            for (let c = 0; c < cols; c++) {
                for (let r = 0; r < rows; r++) {
                    allCoords.push(`${c},${r}`);
                }
            }
            // 隨機抽 6 個不重複的位置放金幣
            for (let i = 0; i < 6; i++) {
                let randIndex = Math.floor(Math.random() * allCoords.length);
                forcedCoinCoords.push(allCoords.splice(randIndex, 1)[0]);
            }
        }

        // 🌟 每次產生新盤面前，清空上一局預先生成的金幣數值紀錄
        this.state.currentCoinValues = {};

        for (let c = 0; c < cols; c++) {
            newGrid[c] = [];
            for (let r = 0; r < rows; r++) {
                // Hold & Win 期間的特殊盤面生成
                if (this.state.isHoldAndWin) {
                    if (this.state.lockedCoins[`${c},${r}`] !== undefined) {
                        newGrid[c].push(20); 
                    } else {
                        let isCoin = Math.random() < 0.12; 
                        let dummyType = Math.floor(Math.random() * 9) + 1;
                        newGrid[c].push(isCoin ? 20 : dummyType); 
                        // 重轉時掉落的新金幣，立刻賦予數值
                        if (isCoin) this.state.currentCoinValues[`${c},${r}`] = this.getRandomCoinValue();
                    }
                }
                // 一般遊戲的盤面生成
                else {
                    if (isBuyFeature && forcedCoinCoords.includes(`${c},${r}`)) {
                        newGrid[c].push(20);
                        // 購買特色時強制塞入的金幣賦予數值
                        this.state.currentCoinValues[`${c},${r}`] = this.getRandomCoinValue();
                    } else {
                        let type = this.getWeightedSymbol();
                        newGrid[c].push(type);
                        // 一般旋轉如果剛好骰到金幣，也賦予數值
                        if (type === 20) {
                            this.state.currentCoinValues[`${c},${r}`] = this.getRandomCoinValue();
                        }
                    }
                }
            }
        }

        return newGrid;
    }

    async startSpin(isBuyFeature = false) {
        if (this.state.isSpinning) return;
        
        // Hold & Win 期間不需要扣錢
        let cost = isBuyFeature ? this.state.bet * this.config.mechanics.featureBuyCostMulti : this.state.bet;
        if (!this.state.isFreeGame && !this.state.isHoldAndWin && this.state.credit < cost) {
            if(this.callbacks.onError) this.callbacks.onError("餘額不足！"); return;
        }

        this.state.isSpinning = true;

        if (!this.state.isFreeGame && !this.state.isHoldAndWin) {
            this.state.currentWin = 0;
            this.state.credit -= cost;
            if(this.callbacks.onBalanceChange) this.callbacks.onBalanceChange(this.state.credit);
        }

        if(this.callbacks.onSpinStart) this.callbacks.onSpinStart(isBuyFeature, this.state.isHoldAndWin);

        this.state.gridData = this.generateRandomGrid(isBuyFeature);

        if(this.callbacks.playSpinAnimation) {
            await this.callbacks.playSpinAnimation(this.state.gridData);
        }

        await this.checkLogic();
    }

    calculateWins(gridData = this.state.gridData) {
        let matches = new Set();
        let roundScore = 0;
        let scatterCount = 0;
        let newCoinCoords = []; // 記錄這局出現的金幣座標

        const { cols, rows, lines } = this.config.mechanics;
        const symbolsConfig = this.config.symbols;
        const paylines = this.config.paylines;
        const WILD_ID = 10;
        const SCATTER_ID = 11;
        const COIN_ID = 20;

        // 1. 統計特殊符號數量與位置
        for (let c = 0; c < cols; c++) {
            for (let r = 0; r < rows; r++) {
                if (gridData[c][r] === SCATTER_ID) scatterCount++;
                if (gridData[c][r] === COIN_ID) newCoinCoords.push(`${c},${r}`);
            }
        }

        // ★ Hold & Win 期間不計算一般連線贏分
        if (!this.state.isHoldAndWin) {
            // 2. 依序掃描 20 條賠付線 (由左至右)
            paylines.forEach((line) => {
                let matchCount = 0;
                let firstSymbol = -1;
                let currentLineMatches = []; 

                for (let c = 0; c < cols; c++) {
                    let r = line[c];
                    let currentSymbol = gridData[c][r];

                    if (firstSymbol === -1) {
                        if (currentSymbol !== WILD_ID && currentSymbol !== SCATTER_ID && currentSymbol !== COIN_ID && currentSymbol !== 99) {
                            firstSymbol = currentSymbol;
                        }
                    }

                    if (currentSymbol === firstSymbol || currentSymbol === WILD_ID) {
                        if (firstSymbol === -1) firstSymbol = WILD_ID;
                        matchCount++;
                        currentLineMatches.push(`${c},${r}`);
                    } else {
                        break; 
                    }
                }

                if (matchCount >= 3) {
                    let targetId = (firstSymbol === WILD_ID) ? 1 : firstSymbol; 
                    let symInfo = symbolsConfig[targetId];

                    if (symInfo && symInfo.payouts && symInfo.payouts[matchCount]) {
                        let payout = symInfo.payouts[matchCount];
                        let lineBet = this.state.bet / lines; 
                        roundScore += payout * lineBet;
                        currentLineMatches.forEach(coord => matches.add(coord));
                    }
                }
            });
        }

        return { matches, roundScore, scatterCount, newCoinCoords };
    }

    async checkLogic() {
        const { matches, roundScore, scatterCount, newCoinCoords } = this.calculateWins();
        
        // ============================================
        // ★ 階段 A：目前處於 Hold & Win 模式中
        // ============================================
        if (this.state.isHoldAndWin) {
            let isNewCoinLanded = false;

            // 檢查是否有「新的」金幣掉進來
            newCoinCoords.forEach(coord => {
                if (this.state.lockedCoins[coord] === undefined) {
                    this.state.lockedCoins[coord] = this.getRandomCoinValue();
                    isNewCoinLanded = true;
                }
            });

            // 邏輯核心：有新金幣就重置次數，沒有就扣 1 次
            if (isNewCoinLanded) {
                this.state.respinLeft = 3; 
            } else {
                this.state.respinLeft--;
            }

            // 呼叫 UI 更新 (讓前端秀出鎖定的特效與剩餘次數)
            if (this.callbacks.onRespinUpdate) {
                await this.callbacks.onRespinUpdate(this.state.respinLeft, this.state.lockedCoins, isNewCoinLanded);
            }

            let lockedCount = Object.keys(this.state.lockedCoins).length;
            
            // 結束條件：次數歸零，或是 15 格全部滿了 (Grand Jackpot)
            if (lockedCount >= 15 || this.state.respinLeft <= 0) {
                await this.endHoldAndWin(lockedCount >= 15);
                return;
            }

            this.endSpin(scatterCount); 
            return;
        }

        // ============================================
        // ★ 階段 B：一般遊戲模式
        // ============================================
        if (roundScore > 0) {
            this.state.currentWin += roundScore;
            if(this.callbacks.playWinAnimation) { 
                await this.callbacks.playWinAnimation(matches, roundScore, 1, this.state.currentWin); 
            }
        }

        // 檢查是否觸發 Hold & Win (6 顆以上金幣)
        if (newCoinCoords.length >= 6) {
            this.state.isHoldAndWin = true;
            this.state.respinLeft = 3;
            this.state.lockedCoins = {};

            newCoinCoords.forEach(coord => {
                this.state.lockedCoins[coord] = this.state.currentCoinValues[coord];
            });

            if (this.callbacks.onHoldAndWinTrigger) {
                await this.callbacks.onHoldAndWinTrigger(this.state.respinLeft, this.state.lockedCoins);
            }
            
            // ★★★ 加上這一行！呼叫 endSpin 來解除旋轉鎖定，並讓系統自動開始跑迴圈 ★★★
            this.endSpin(scatterCount); 
            
            return; 
        }

        this.endSpin(scatterCount);
    }

    // ★ 結算 Hold & Win 獎金
    async endHoldAndWin(isGrand) {
        let totalMultiplier = 0;
        let jackpots = { MINI: 0, MINOR: 0, MAJOR: 0, GRAND: isGrand ? 1 : 0 };

        // 統計所有鎖定金幣的價值
        Object.values(this.state.lockedCoins).forEach(val => {
            if (typeof val === 'number') {
                totalMultiplier += val;
            } else if (jackpots[val] !== undefined) {
                jackpots[val]++;
            }
        });

        // 彩金表 (你可以依據企劃調整倍率)
        let hwWin = totalMultiplier * this.state.bet;
        hwWin += jackpots.MINI * this.state.bet * 10;    // MINI = 10倍
        hwWin += jackpots.MINOR * this.state.bet * 50;   // MINOR = 50倍
        hwWin += jackpots.MAJOR * this.state.bet * 250;  // MAJOR = 250倍
        if (isGrand) hwWin += this.state.bet * 1000;     // GRAND = 1000倍

        this.state.currentWin += hwWin;

        if (this.callbacks.onHoldAndWinEnd) {
            await this.callbacks.onHoldAndWinEnd(hwWin, isGrand, jackpots);
        }

        // 狀態重置，回歸一般遊戲
        this.state.isHoldAndWin = false;
        this.state.respinLeft = 0;
        this.state.lockedCoins = {};
        
        this.endSpin(0);
    }

    endSpin(scatterCount) {
        this.state.isSpinning = false;
        
        // (省略原本的免費遊戲結算邏輯，因為架構不變...)
        if (!this.state.isFreeGame && !this.state.isHoldAndWin && this.state.currentWin > 0) {
            this.state.credit += this.state.currentWin;
            this.state.currentWin = 0;
            if(this.callbacks.onBalanceChange) this.callbacks.onBalanceChange(this.state.credit);
        }
        
        if(this.callbacks.onSpinComplete) this.callbacks.onSpinComplete(scatterCount);
    }
}