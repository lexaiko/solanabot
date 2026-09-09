import axios from 'axios';

const tokens = [
  '6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx',
  '8RVBk8vxLiUHueLUW1f4izFVqN3nWippLhkohKg6EGkS',
  '5qSo7XuuMJ16iqHqVMEwgvG3BTREuHXXBGkpipw8uVD7',
  '44aP1PKhZwZAgfzPQUfh34FSWvMdfEMNnSJhAGavTCTJ',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
];

async function checkNames() {
  for (const t of tokens) {
    try {
      const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${t}`);
      const pair = res.data?.pairs?.[0];
      console.log(`CA: ${t.slice(0, 8)}... | Symbol: ${pair?.baseToken?.symbol || 'UNKNOWN'} | Name: ${pair?.baseToken?.name || 'UNKNOWN'} | Price: $${pair?.priceUsd || '0'}`);
    } catch (e: any) {
      console.log(`CA: ${t.slice(0, 8)}... | Error: ${e.message}`);
    }
  }
}

checkNames();
