// config.js
const GameConfig = {
    gameId: "dragon_treasure_hold_n_win", 
    
    mechanics: {
        cols: 5,                    // 改為 5 軸
        rows: 3,                    // 改為 3 列
        enableCascading: false,     // 關閉掉落機制
        lines: 20,                  // 新增：20 條賠付線
        featureBuyCostMulti: 100    
    },

    // 標準 20 條賠付線座標 [col0_row, col1_row, col2_row, col3_row, col4_row]
    // 數字 0代表最上排, 1代表中間排, 2代表最下排
    paylines: [
        [1,1,1,1,1], [0,0,0,0,0], [2,2,2,2,2], // 1~3: 平行線
        [0,1,2,1,0], [2,1,0,1,2],              // 4~5: V與倒V
        [0,0,1,2,2], [2,2,1,0,0],              // 6~7
        [1,0,1,2,1], [1,2,1,0,1],              // 8~9
        [1,0,0,1,2], [1,2,2,1,0],              // 10~11
        [0,1,0,1,0], [2,1,2,1,2],              // 12~13
        [0,1,1,1,0], [2,1,1,1,2],              // 14~15
        [0,0,2,0,0], [2,2,0,2,2],              // 16~17
        [1,1,0,1,1], [1,1,2,1,1],              // 18~19
        [0,2,0,2,0]                            // 20
    ],

    assets: {
        images: {
            bg: `background.jpg`,
            symbols: {
                1: `s1.png`, 2: `s2.png`, 3: `s3.png`, 4: `s4.png`, 5: `s5.png`,
                6: `s6.png`, 7: `s7.png`, 8: `s8.png`, 9: `s9.png`,
                10: `WILD.png`, 11: `SCATTER.png`,
                20: `gold.png` // ★ 修改：準備給 Hold & Win 用的金幣素材
            }
        },
        audio: {
            bgmMain: `bgm_main.mp3`, bgmFree: `bgm_free.mp3`,
            sfxSpin: `sfx_spin.mp3`, sfxStop: `sfx_stop.mp3`
        }
    },

    // --- 符號與機率模型 (轉換為 5x3 線連線賠率) ---
    symbols: {
        1:  { type: 'high', payouts: {3: 20, 4: 50, 5: 200}, weightBase: 2.0, inFree: true },
        2:  { type: 'high', payouts: {3: 15, 4: 30, 5: 150}, weightBase: 3.0, inFree: true },
        3:  { type: 'high', payouts: {3: 10, 4: 20, 5: 100}, weightBase: 5.0, inFree: true },
        4:  { type: 'mid',  payouts: {3: 8,  4: 15, 5: 80},  weightBase: 8.0, inFree: true },
        5:  { type: 'mid',  payouts: {3: 5,  4: 10, 5: 60},  weightBase: 10.0, inFree: true },
        6:  { type: 'low',  payouts: {3: 4,  4: 8,  5: 40},  weightBase: 14.0, inFree: true },
        7:  { type: 'low',  payouts: {3: 3,  4: 6,  5: 30},  weightBase: 16.0, inFree: true },
        8:  { type: 'low',  payouts: {3: 2,  4: 5,  5: 20},  weightBase: 18.0, inFree: true },
        9:  { type: 'low',  payouts: {3: 1,  4: 3,  5: 10},  weightBase: 22.0, inFree: true },
        
        // WILD 現在可以參與一般連線，給予基礎權重
        10: { type: 'wild', weightBase: 2.0, inFree: true }, 
        
        // SCATTER 通常不受賠付線限制，賠付乘上總押注
        11: { type: 'scatter', payouts: {3: 2, 4: 10, 5: 100}, weightBase: 1.64, inFree: true },
        
        // ★ 預留：Hold & Win 觸發金幣 (未來再實作專屬數值)
        20: { type: 'coin', weightBase: 3.0, inFree: true } 
    }
};

export default GameConfig;