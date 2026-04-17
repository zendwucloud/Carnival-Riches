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

    generateRandomGrid(isBuyFeature = false, featureType = null) {
        let newGrid = [];
        const { cols, rows } = this.config.mechanics;
        
        let forcedCoords = [];
        let forceType = null; 
        
        if (isBuyFeature) {
            let allCoords = [];
            for (let c = 0; c < cols; c++) {
                for (let r = 0; r < rows; r++) { allCoords.push(`${c},${r}`); }
            }

            // ★ 依據傳進來的 featureType 決定塞帳篷還是金幣
            if (featureType === 'fg') {
                forceType = 11; 
                for (let i = 0; i < 4; i++) { 
                    let randIndex = Math.floor(Math.random() * allCoords.length);
                    forcedCoords.push(allCoords.splice(randIndex, 1)[0]);
                }
            } else if (featureType === 'hw') {
                forceType = 20; 
                for (let i = 0; i < 6; i++) { 
                    let randIndex = Math.floor(Math.random() * allCoords.length);
                    forcedCoords.push(allCoords.splice(randIndex, 1)[0]);
                }
            }
        }

        // 每次產生新盤面前，清空上一局預先生成的金幣數值紀錄
        this.state.currentCoinValues = {};

        for (let c = 0; c < cols; c++) {
            newGrid[c] = [];
            for (let r = 0; r < rows; r++) {
                // Hold & Win 期間的特殊盤面生成
                if (this.state.isHoldAndWin) {
                    if (this.state.lockedCoins[`${c},${r}`] !== undefined) {
                        newGrid[c].push(20); 
                    } else {
                        let isCoin = Math.random() < 0.06; 
                        let dummyType = Math.floor(Math.random() * 9) + 1;
                        newGrid[c].push(isCoin ? 20 : dummyType); 
                        // 重轉時掉落的新金幣，立刻賦予數值
                        if (isCoin) this.state.currentCoinValues[`${c},${r}`] = this.getRandomCoinValue();
                    }
                }
                // 一般遊戲的盤面生成
                else {
                    // ★ 修改：依照剛剛抽籤決定的類型 (forceType) 強制塞入
                    if (isBuyFeature && forcedCoords.includes(`${c},${r}`)) {
                        newGrid[c].push(forceType); 
                        // 如果這局輪到出金幣，記得要給它印上數字
                        if (forceType === 20) {
                            this.state.currentCoinValues[`${c},${r}`] = this.getRandomCoinValue();
                        }
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

    // ★ 加入 featureType 參數 ('fg' 或 'hw')
    async startSpin(isBuyFeature = false, featureType = null) {
        if (this.state.isSpinning) return;
        
        // ★ 依據購買的類型決定扣款金額 (FG: 80倍, HW: 120倍)
        let cost = this.state.bet;
        if (isBuyFeature) {
            cost = featureType === 'fg' ? this.state.bet * 80 : this.state.bet * 120;
        }

        if (!this.state.isFreeGame && !this.state.isHoldAndWin && this.state.credit < cost) {
            if(this.callbacks.onError) this.callbacks.onError("餘額不足！"); return;
        }

        this.state.isSpinning = true;

        if (!this.state.isFreeGame && !this.state.isHoldAndWin) {
            this.state.currentWin = 0;
            this.state.credit -= cost;
            if(this.callbacks.onBalanceChange) this.callbacks.onBalanceChange(this.state.credit);
        } else if (this.state.isFreeGame) {
            this.state.freeSpinsLeft--; 
            if(this.callbacks.onFreeSpinUpdate) this.callbacks.onFreeSpinUpdate(this.state.freeSpinsLeft);
        }

        if(this.callbacks.onSpinStart) this.callbacks.onSpinStart(isBuyFeature, this.state.isHoldAndWin);

        // ★ 把 featureType 傳給盤面生成器
        this.state.gridData = this.generateRandomGrid(isBuyFeature, featureType);

        if(this.callbacks.playSpinAnimation) {
            await this.callbacks.playSpinAnimation(this.state.gridData);
        }

        await this.checkLogic();
    }

    // 替換區塊開始：完整版的計算贏分邏輯
    calculateWins(gridData = this.state.gridData) {
        let matches = new Set();
        let roundScore = 0;
        let winningLines = []; 
        let scatterCount = 0;
        let newCoinCoords = [];

        const { cols, rows, lines } = this.config.mechanics;
        const paylines = this.config.paylines;
        const symbolsConfig = this.config.symbols;
        const WILD_ID = 10;
        const SCATTER_ID = 11;
        const COIN_ID = 20;

        // 1. 找出畫面上的 SCATTER 與金幣
        let tempScatterCoords = []; // ★ 新增：先暫存 SCATTER 的座標
        for (let c = 0; c < cols; c++) {
            for (let r = 0; r < rows; r++) {
                if (gridData[c][r] === SCATTER_ID) {
                    scatterCount++;
                    tempScatterCoords.push(`${c},${r}`); // ★ 暫存，先不要加進 matches
                }
                if (gridData[c][r] === COIN_ID) {
                    newCoinCoords.push(`${c},${r}`);
                }
            }
        }

        // 2. 如果不是 Hold & Win 模式，才計算 20 條連線與贏分
        if (!this.state.isHoldAndWin) {
            paylines.forEach((line, lineIndex) => {
                let matchCount = 0;
                let firstSymbol = -1;
                let currentLineMatches = []; 

                for (let c = 0; c < cols; c++) {
                    let r = line[c];
                    let currentSymbol = gridData[c][r];
                    
                    // 遇到 SCATTER 或 金幣，這條線直接中斷
                    if (currentSymbol === SCATTER_ID || currentSymbol === COIN_ID) {
                        break; 
                    }

                    if (matchCount === 0) {
                        firstSymbol = currentSymbol;
                        matchCount++;
                        currentLineMatches.push(`${c},${r}`);
                    } else {
                        // 判斷是否能連線 (同符號，或是百搭)
                        if (currentSymbol === firstSymbol || currentSymbol === WILD_ID || firstSymbol === WILD_ID) {
                            matchCount++;
                            currentLineMatches.push(`${c},${r}`);
                            if (firstSymbol === WILD_ID && currentSymbol !== WILD_ID) {
                                firstSymbol = currentSymbol; 
                            }
                        } else {
                            break; 
                        }
                    }
                }

                // 計算該條線的贏分 (3連線以上)
                if (matchCount >= 3) {
                    let targetId = (firstSymbol === WILD_ID) ? 1 : firstSymbol; 
                    let symInfo = symbolsConfig[targetId];

                    if (symInfo && symInfo.payouts && symInfo.payouts[matchCount]) {
                        let payout = symInfo.payouts[matchCount];
                        let lineBet = this.state.bet / lines; 
                        let lineScore = payout * lineBet;
                        roundScore += lineScore;
                        
                        winningLines.push({
                            index: lineIndex,
                            score: lineScore,
                            coords: currentLineMatches 
                        });
                        
                        currentLineMatches.forEach(coord => matches.add(coord));
                    }
                }
            });

            // 3. 計算 SCATTER 的贏分
            if (scatterCount >= 3) {
                let scatterInfo = symbolsConfig[SCATTER_ID];
                if (scatterInfo && scatterInfo.payouts && scatterInfo.payouts[scatterCount]) {
                    roundScore += scatterInfo.payouts[scatterCount] * this.state.bet;
                    
                    // ★ 新增：確定 SCATTER 有中獎 (大於等於3個) 才把它們加入發光名單！
                    tempScatterCoords.forEach(coord => matches.add(coord));
                }
            }
        }

        return { matches, roundScore, winningLines, scatterCount, newCoinCoords };
    }

    async checkLogic() {
        const { matches, roundScore, winningLines, scatterCount, newCoinCoords } = this.calculateWins();
        
        // ============================================
        // 階段 A：目前處於 Hold & Win 模式中
        // ============================================
        if (this.state.isHoldAndWin) {
            let isNewCoinLanded = false;

            newCoinCoords.forEach(coord => {
                if (this.state.lockedCoins[coord] === undefined) {
                    // 🌟 修正：使用生成盤面時已經決定的數值，確保前後端完美同步
                    this.state.lockedCoins[coord] = this.state.currentCoinValues[coord]; 
                    isNewCoinLanded = true;
                }
            });

            if (isNewCoinLanded) this.state.respinLeft = 3; 
            else this.state.respinLeft--;

            if (this.callbacks.onRespinUpdate) await this.callbacks.onRespinUpdate(this.state.respinLeft, this.state.lockedCoins, isNewCoinLanded);

            let lockedCount = Object.keys(this.state.lockedCoins).length;
            if (lockedCount >= 15 || this.state.respinLeft <= 0) {
                await this.endHoldAndWin(lockedCount >= 15);
                return;
            }
            this.endSpin(scatterCount); 
            return;
        }

        // ============================================
        // 階段 B：一般遊戲與贏分結算
        // ============================================
        if (roundScore > 0) {
            this.state.currentWin += roundScore;
            if(this.callbacks.playWinAnimation) { 
                await this.callbacks.playWinAnimation(matches, roundScore, 1, this.state.currentWin, winningLines); 
            }
        }

        // 觸發 Hold & Win (6顆金幣)
        if (newCoinCoords.length >= 6) {
            this.state.isHoldAndWin = true;
            this.state.respinLeft = 3;
            this.state.lockedCoins = {};
            newCoinCoords.forEach(coord => { this.state.lockedCoins[coord] = this.state.currentCoinValues[coord]; });
            
            if (this.callbacks.onHoldAndWinTrigger) await this.callbacks.onHoldAndWinTrigger(this.state.respinLeft, this.state.lockedCoins);
            this.endSpin(scatterCount); 
            return; 
        }

        // ============================================
        // ★ 階段 C：補回！觸發免費遊戲 (4顆帳篷)
        // ============================================
        if (!this.state.isFreeGame && scatterCount >= 4) {
            this.state.isFreeGame = true;
            this.state.freeSpinsLeft = 15; // 給予 15 局
            if (this.callbacks.onFreeGameTrigger) {
                await this.callbacks.onFreeGameTrigger(this.state.freeSpinsLeft, scatterCount);
            }
            this.endSpin(scatterCount);
            return;
        }

        // ============================================
        // ★ 階段 D：補回！免費遊戲結束結算
        // ============================================
        if (this.state.isFreeGame && this.state.freeSpinsLeft <= 0) {
            if (this.callbacks.onFreeGameEnd) {
                await this.callbacks.onFreeGameEnd(this.state.currentWin);
            }
            this.state.isFreeGame = false;
            
            // 結算大獎並加回總分
            if (this.state.currentWin > 0) {
                this.state.credit += this.state.currentWin;
                this.state.currentWin = 0;
                if(this.callbacks.onBalanceChange) this.callbacks.onBalanceChange(this.state.credit);
            }
            
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