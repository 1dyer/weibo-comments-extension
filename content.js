(function() {
    'use strict';

    // ================== GM_* 替换 ==================
    // GM_addStyle -> style 标签
    // GM_xmlhttpRequest -> fetchWithCookie
    // GM_download -> downloadFile
    // GM_setValue / GM_getValue -> chrome.storage.local

    function fetchWithCookie(url) {
        return fetch(url, {
            method: 'GET',
            credentials: 'include',
            headers: {
                'Referer': 'https://weibo.com/',
                'User-Agent': navigator.userAgent
            }
        }).then(res => {
            if (!res.ok) throw new Error(`请求失败: ${res.status}`);
            return res.json();
        });
    }

    function downloadFile(url, filename) {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // 释放对象 URL
        URL.revokeObjectURL(url);
    }


    // ================== 插入样式 ==================
    const style = document.createElement('style');
    style.textContent = `/* 复制 style.css 内容 */`;
    document.head.appendChild(style);

    // ================== 创建UI ==================
    const container = document.createElement('div');
    container.id = 'weibo-comment-crawler';
    container.innerHTML = `
        <div class="crawler-header">
            <div class="crawler-title">微博评论爬取工具</div>
            <div class="crawler-toggle">▼</div>
        </div>
        <div class="crawler-body">
            <input type="text" class="url-input" id="weibo-url" placeholder="输入微博URL" value="${window.location.href}">
            <div class="crawler-stats">
                <span>已爬取: <span id="crawled-count" class="stats-value">0</span> 条</span>
                <span>状态: <span class="status-indicator status-ready"></span><span id="crawler-status">就绪</span></span>
            </div>
            <div class="progress-container">
                <div class="progress-bar" id="progress-bar"></div>
            </div>
            <div class="crawler-buttons">
                <button class="crawler-btn btn-start" id="start-crawl">▶ 开始爬取</button>
                <button class="crawler-btn btn-pause" id="pause-resume" disabled>⏸ 暂停</button>
                <button class="crawler-btn btn-download" id="download-csv" disabled>⭳ 下载CSV</button>
            </div>
            <div class="crawler-log" id="crawler-log"></div>
        </div>
        <div class="watermark">Created by Ldyer | v1.2</div>
    `;
    document.body.appendChild(container);

    // ================== UI元素 ==================
    const header = container.querySelector('.crawler-header');
    const toggleBtn = container.querySelector('.crawler-toggle');
    const body = container.querySelector('.crawler-body');
    const startBtn = container.querySelector('#start-crawl');
    const pauseBtn = container.querySelector('#pause-resume');
    const downloadBtn = container.querySelector('#download-csv');
    const crawledCount = container.querySelector('#crawled-count');
    const crawlerStatus = container.querySelector('#crawler-status');
    const crawlerLog = container.querySelector('#crawler-log');
    const progressBar = container.querySelector('#progress-bar');
    const statusIndicator = container.querySelector('.status-indicator');
    const urlInput = container.querySelector('#weibo-url');

    // ================== 状态变量 ==================
    let isCrawling = false;
    let isPaused = false;
    let stopRequested = false;
    let comments = [];
    let count = 0;
    let lastPauseTime = 0;
    let authorName = '';
    let pauseResolve = null;

    // ================== UI事件 ==================
    header.addEventListener('click', () => {
        container.classList.toggle('expanded');
    });

    function addLog(msg, type='info') {
        const now = new Date().toTimeString().slice(0,8);
        const entry = document.createElement('div');
        entry.className = `log-entry log-${type}`;
        entry.innerHTML = `[${now}] ${msg}`;
        crawlerLog.appendChild(entry);
        crawlerLog.scrollTop = crawlerLog.scrollHeight;
    }

    function updateStatusIndicator(status) {
        statusIndicator.className = 'status-indicator';
        statusIndicator.classList.add(`status-${status}`);
    }

    function updateProgressBar(percent) {
        progressBar.style.width = `${percent}%`;
    }

    // ================== 爬取逻辑 ==================
    function decodeBase62(b62Str) {
        const charset = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
        let num = 0;
        for (let i=0;i<b62Str.length;i++){
            num = num*62 + charset.indexOf(b62Str[i]);
        }
        return num;
    }

    function urlToMid(url){
        let result='';
        for(let i=url.length;i>0;i-=4){
            const start=Math.max(i-4,0);
            let num=decodeBase62(url.substring(start,i)).toString();
            if(start!==0) num=num.padStart(7,'0');
            result=num+result;
        }
        return parseInt(result);
    }

    function getKeyword(url){
        // 去掉 ? 及其后的参数
        const cleanUrl = url.split('?')[0];
        const parts = cleanUrl.split('/');
        const uid = parts[parts.length-2];
        const mid = urlToMid(parts[parts.length-1]);
        return { uid, mid };
    }
    async function getAuthorName(uid){
        try{
            const data=await fetchWithCookie(`https://weibo.com/ajax/profile/info?custom=${uid}`);
            return data.data.user.screen_name;
        }catch(e){
            throw new Error('获取博主用户名失败');
        }
    }

    function parseCommentData(data){
        const dt=new Date(data.created_at);

        // 解析粉丝牌
        let fansIcon = '';
        try {
            const fanMap = { '1': '铁粉', '2': '金粉', '3': '钻粉' };
            const iconUrl = data.user.fansIcon?.icon_url || '';
            if (iconUrl.length >= 7) {
                const fanType = fanMap[iconUrl.charAt(iconUrl.length - 7)] || '';
                const fanLevel = iconUrl.charAt(iconUrl.length - 5) || '';
                fansIcon = fanType ? `${fanType}${fanLevel}` : '';
            }
        } catch (e) {
            fansIcon = '';
        }

        return {
            idstr: data.idstr,
            rootidstr: data.rootidstr,
            created_at: dt.toLocaleString(),
            user_id: data.user.id,
            screen_name: data.user.screen_name,
            text_raw: data.text_raw,
            like: data.like_counts,
            total_number: data.total_number||0,
            fansIcon: fansIcon, 
            com_source: data.source?.substring(2)||'',
            description: data.user.description||'',
            verified: data.user.verified?'是':'否',
            gender: data.user.gender==='m'?'男':(data.user.gender==='f'?'女':'未知'),
            svip: data.user.svip||'',
            followers_count: data.user.followers_count,
            friends_count: data.user.friends_count,
            total_cnt: parseInt(data.user.status_total_counter?.total_cnt.replace(/,/g,''))||0
        };
    }

    async function getComments(uid, mid, max_id='', fetch_level=0){
        let url=`https://weibo.com/ajax/statuses/buildComments?flow=1&is_reload=1&id=${mid}&is_show_bulletin=2&is_mix=0&count=20&uid=${uid}&fetch_level=${fetch_level}&locale=zh-CN`;
        if(max_id) url += `&max_id=${max_id}`;
        return fetchWithCookie(url);
    }

    async function crawlComments(uid, mid, max_id, fetch_level) {
        try {
            const data = await getComments(uid, mid, max_id, fetch_level);
            const commentsData = data.data || [];
            const next_max_id = data.max_id || 0;

            for (const comment of commentsData) {
                if (stopRequested) break;

                if (isPaused) {
                    await new Promise(resolve => pauseResolve = resolve);
                }

                count++;
                crawledCount.textContent = count;
                updateProgressBar(Math.min(100, count % 100));

                const parsedComment = parseCommentData(comment);
                if (fetch_level === 0) parsedComment.rootidstr = '';

                comments.push([
                    count,
                    parsedComment.idstr,
                    parsedComment.rootidstr,
                    parsedComment.user_id,
                    parsedComment.created_at,
                    parsedComment.screen_name,
                    parsedComment.gender,
                    parsedComment.text_raw,
                    parsedComment.like,
                    parsedComment.total_number,
                    parsedComment.fansIcon,
                    parsedComment.com_source,
                    parsedComment.description,
                    parsedComment.verified,
                    parsedComment.svip,
                    parsedComment.followers_count,
                    parsedComment.friends_count,
                    parsedComment.total_cnt
                ]);

                // 每爬取100条数据，暂停5秒防止反爬
                if (count % 100 === 0 && count !== lastPauseTime) {
                    lastPauseTime = count;
                    addLog(`已爬取 ${count} 条数据，防止爬取过快，等待5秒...`, 'warning');
                    crawlerStatus.textContent = '暂停中...';
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    crawlerStatus.textContent = '爬取中...';
                    addLog('暂停结束，继续爬取', 'info');
                }

                // 爬取二级评论
                if (parsedComment.total_number > 0 && fetch_level === 0) {
                    await crawlComments(uid, parsedComment.idstr, 0, 1);
                }
            }

            // ================== 新增：每处理完一批数据，输出总爬取数 ==================
            addLog(`当前总共已爬取 ${count} 条评论`, 'info');

            // 如果有下一页，继续爬取
            if (next_max_id !== 0 && !stopRequested) {
                await crawlComments(uid, mid, next_max_id, fetch_level);
            }
        } catch (error) {
            addLog(`爬取评论失败: ${error.message}`, 'error');
        }
    }


    function downloadCSV(){
        if(comments.length===0){ addLog('没有评论数据可下载','error'); return; }
        const headers=[
            '序号','评论标识号','上级评论','用户标识符','时间','用户名','性别',
            '评论内容','评论点赞数','评论回复数','粉丝牌','评论IP','用户简介',
            '是否认证','会员等级','用户粉丝数','用户关注数','用户转赞评数'
        ];
        const BOM='\uFEFF';
        let csv=BOM+headers.join(',')+'\n';
        comments.forEach(row=>{
            csv+=row.map(f=>typeof f==='string'?`"${f.replace(/"/g,'""')}"`:f).join(',')+'\n';
        });
        const blob=new Blob([csv],{type:'text/csv;charset=utf-8'});
        const url=URL.createObjectURL(blob);
        const filename=`${authorName||'微博评论'}_${new Date().toISOString().slice(0,10)}.csv`;
        downloadFile(url, filename);
    }

    // ================== 按钮事件 ==================
    startBtn.addEventListener('click', async ()=>{
        if(isCrawling) return;
        isCrawling=true;
        isPaused=false;
        stopRequested=false;
        startBtn.disabled=true;
        pauseBtn.disabled=false;
        downloadBtn.disabled=false;
        crawlerStatus.textContent='爬取中...';
        updateStatusIndicator('active');
        crawledCount.textContent='0';
        comments=[];
        count=0;
        lastPauseTime=0;
        updateProgressBar(0);
        crawlerLog.innerHTML='';

        try{
            const url=urlInput.value.trim();
            if(!url) throw new Error('请输入微博URL');
            const {uid, mid}=getKeyword(url);
            authorName=await getAuthorName(uid);
            addLog(`博主用户名: ${authorName}`,'info');
            addLog(`UID: ${uid}, MID: ${mid}`,'info');
            await crawlComments(uid, mid, '', 0);
            isCrawling=false;
            crawlerStatus.textContent='完成';
            updateStatusIndicator('ready');
            startBtn.disabled=false;
            pauseBtn.disabled=true;
            downloadBtn.disabled=false;
            updateProgressBar(100);
            addLog(`爬取完成！总共爬取 ${count} 条`,'success');
        }catch(e){
            isCrawling=false;
            crawlerStatus.textContent='错误';
            updateStatusIndicator('error');
            startBtn.disabled=false;
            pauseBtn.disabled=true;
            downloadBtn.disabled=false;
            addLog(`初始化失败: ${e.message}`,'error');
        }
    });

    pauseBtn.addEventListener('click', ()=>{
        if(!isCrawling) return;
        if(isPaused){
            isPaused=false;
            pauseBtn.textContent='⏸ 暂停';
            crawlerStatus.textContent='爬取中...';
            updateStatusIndicator('active');
            if(pauseResolve) { pauseResolve(); pauseResolve=null; }
            addLog('爬取已恢复','info');
        }else{
            isPaused=true;
            pauseBtn.textContent='▶ 继续';
            crawlerStatus.textContent='已暂停';
            updateStatusIndicator('paused');
            addLog('爬取已暂停','warning');
        }
    });

    downloadBtn.addEventListener('click', ()=>{
        downloadCSV();
    });

})();
