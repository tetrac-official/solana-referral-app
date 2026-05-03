# Make a leaderboard for the affiliates
- show current affiliate tier 
- show total sign ups 
- show total earned
- button to promote affiliate when admin is connected. See `Promote Affiliate` below

```bash
node scripts/affiliate-stats.cjs --all   # list every registered affiliate
```

# anchor program 
- prevent payer from being affiliate , if payer == affiliate => all funds to merchant : tx still validates. 
- test `USDC` payments with random sizes, ensure `receive_and_split` works correctly. 
- redhat pentest suite, look for exploits, vulnerabilities. 

# Promote Affiliate 
- right now admin must run a script to promote an affiliate. Within the leaderboard page, the admin should be able to connect with wallet, and sign messages to promote an affiliate.