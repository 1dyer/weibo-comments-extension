chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'download') {
        fetch(msg.url)
            .then(res => res.blob())
            .then(blob => {
                const url = URL.createObjectURL(blob);
                chrome.downloads.download({
                    url: url,
                    filename: msg.filename,
                    saveAs: true
                });
            });
    }
});
